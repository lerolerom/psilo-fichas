import type { Config } from "./config.js";
import { normalizarTelefono } from "./config.js";
import type { Dueno, Escalacion, Lead, Paso, Store } from "./db.js";
import { ETAPAS } from "./db.js";
import type { EventoWA, WhatsApp } from "./whatsapp.js";
import type { AgenteSetter, Decision } from "./agent/agente.js";
import { etapaFinal } from "./agent/agente.js";
import { armarContexto } from "./contexto.js";
import { detectarRiesgo, mensajeContencion } from "./riesgo.js";
import { DIA, HORA, type Horario, dentroDeHorario, proximoToque, siguienteMomentoPermitido, ventanaAbierta } from "./tiempo.js";

export interface CalendarioEscritura {
  crearEvaluacion(inicioIso: string, titulo: string, descripcion: string): Promise<string>;
}

type Entrante = Extract<EventoWA, { tipo: "entrante" }>;
type Eco = Extract<EventoWA, { tipo: "eco" }>;

const PASOS_SIN_SEGUIMIENTO: Paso[] = ["agendado", "cerrado"];
const ETAPAS_CERRADAS = new Set(["Lost", "Not qualified", "Converted", "Agendo sesion Evaluacion"]);

export class Motor {
  private horario: Horario;
  private ocupados = new Set<string>(); // leads con un turno en curso
  private ultimoInAdmin = new Map<string, string>();

  constructor(
    private cfg: Config,
    private store: Store,
    private wa: WhatsApp,
    private agente: AgenteSetter,
    private calendario: CalendarioEscritura | null,
    private reloj: () => Date = () => new Date(),
  ) {
    this.horario = {
      tz: cfg.TZ_NEGOCIO,
      horaInicio: cfg.HORA_INICIO_ENVIO,
      horaFin: cfg.HORA_FIN_ENVIO,
      feriados: cfg.feriados,
    };
  }

  // =====================================================================
  // Entradas
  // =====================================================================

  async procesar(eventos: EventoWA[]): Promise<void> {
    for (const ev of eventos) {
      try {
        if (ev.tipo === "entrante") await this.entrante(ev);
        else if (ev.tipo === "eco") await this.eco(ev);
        else if (ev.tipo === "estado" && ev.estado === "failed") {
          this.store.log(ev.para, "envio_fallido", ev.error);
        }
      } catch (e) {
        console.error("Error procesando evento", ev, e);
        this.store.log(null, "error", String(e));
      }
    }
  }

  private presentacion(lead: Lead): string | null {
    if (lead.dueno === "MARIO") return this.cfg.PRESENTACION_MARIO;
    if (lead.dueno === "DANI") return this.cfg.PRESENTACION_DANI || null;
    return null;
  }

  private async entrante(ev: Entrante): Promise<void> {
    const ahora = this.reloj();

    if (this.cfg.adminNumeros.includes(ev.de)) {
      this.ultimoInAdmin.set(ev.de, ahora.toISOString());
      await this.comandoAdmin(ev.de, ev.texto);
      return;
    }

    let lead = this.store.lead(ev.de);
    if (!lead) {
      const origen = ev.referral ? (ev.referral.source_type === "ad" ? "anuncio" : "referral") : "directo";
      lead = this.store.crearLead(
        ev.de,
        {
          dueno: this.cfg.DUENO_POR_DEFECTO,
          nombre: null,
          origen,
          anuncio: ev.referral?.headline ?? ev.referral?.source_url ?? null,
        },
        ahora,
      );
      if (ev.nombrePerfil) this.store.actualizar(ev.de, { notas: `Nombre de perfil de WhatsApp: ${ev.nombrePerfil}` });
    }

    const nuevo = this.store.guardarMensaje({
      telefono: ev.de,
      direccion: "in",
      tipo: ev.clase,
      texto: ev.texto,
      wa_id: ev.waId,
      autor: "lead",
      ts: ev.ts.toISOString(),
    });
    if (!nuevo) return; // reintento de Meta

    // Chats de Vero: no se leen ni se contestan, y quedan como no leídos.
    // Única excepción: una señal de riesgo se avisa a los fundadores (sin escribirle al lead).
    if (lead.dueno === "VERO") {
      if (detectarRiesgo(ev.texto)) {
        await this.notificar(`URGENTE: posible señal de riesgo en un chat de VERO (+${ev.de}). No se respondió nada. Mensaje: "${resumir(ev.texto)}"`);
      }
      return;
    }

    const cambios: Partial<Lead> = {
      ultimo_in: ahora.toISOString(),
      intentos_sin_respuesta: 0,
      proximo_toque: null,
    };
    if (lead.paso === "contactado" || lead.paso === "nuevo") cambios.paso = "abrio";
    if (lead.etapa === "Not qualified" && !lead.pausado) cambios.etapa = "Intake"; // volvió a escribir

    // Riesgo: antes que cualquier otra cosa, sin pasar por el agente de ventas.
    const riesgo = detectarRiesgo(ev.texto);
    if (riesgo) {
      this.store.actualizar(ev.de, { ...cambios, pausado: 1, motivo_pausa: `riesgo ${riesgo}`, pendiente_desde: null });
      const lead2 = this.store.lead(ev.de)!;
      if (riesgo === "alto" && this.cfg.MODO !== "pausado") {
        await this.enviarTexto(lead2, mensajeContencion(lead2.nombre), "sistema");
      }
      await this.escalar(lead2, {
        categoria: "riesgo",
        motivo:
          riesgo === "alto"
            ? `URGENTE. Posible riesgo de autolesión. Se envió mensaje de contención con 171 opción 6 y 911. Mensaje: "${ev.texto}"`
            : `Señal ambigua de riesgo. No se respondió nada. Mensaje: "${ev.texto}"`,
        propuesta: null,
      });
      return;
    }

    if (lead.pausado) {
      this.store.actualizar(ev.de, cambios);
      await this.notificar(`El lead +${ev.de}${lead.nombre ? ` (${lead.nombre})` : ""} escribió y su chat está en pausa (${lead.motivo_pausa ?? "sin motivo"}): "${resumir(ev.texto || `[${ev.clase}]`)}"`);
      return;
    }

    if (lead.humano_hasta && new Date(lead.humano_hasta) > ahora) {
      this.store.actualizar(ev.de, cambios); // alguien del equipo está llevando el chat
      return;
    }

    this.store.actualizar(ev.de, { ...cambios, pendiente_desde: lead.pendiente_desde ?? ahora.toISOString() });
  }

  /** Mensaje escrito por el equipo desde la app WhatsApp Business (coexistencia). */
  private async eco(ev: Eco): Promise<void> {
    const ahora = this.reloj();
    let lead = this.store.lead(ev.para);
    if (!lead) {
      // Chat iniciado desde la app: no sabemos de quién es. Por seguridad, el agente no lo toca.
      lead = this.store.crearLead(ev.para, { dueno: this.cfg.DUENO_POR_DEFECTO, origen: "app" }, ahora);
      this.store.actualizar(ev.para, { pausado: 1, motivo_pausa: "chat iniciado desde la app: asignar dueño con DUEÑO" });
    }
    const nuevo = this.store.guardarMensaje({
      telefono: ev.para,
      direccion: "eco",
      tipo: ev.clase,
      texto: ev.texto,
      wa_id: ev.waId,
      autor: "app",
      ts: ev.ts.toISOString(),
    });
    if (!nuevo) return; // era un mensaje nuestro (API) o un reintento
    this.store.actualizar(ev.para, {
      humano_hasta: new Date(ahora.getTime() + this.cfg.HUMANO_SILENCIO_HORAS * HORA).toISOString(),
      pendiente_desde: null,
      ultimo_out: ahora.toISOString(),
    });
  }

  /** Lead de formulario instantáneo, landing o abandonado. */
  async ingresarLead(datos: {
    telefono: string;
    nombre: string | null;
    formulario: string | null;
    origen: "formulario" | "abandonado" | "instagram";
    anuncio: string | null;
    dueno?: Dueno;
  }): Promise<Lead> {
    const tel = normalizarTelefono(datos.telefono);
    const ahora = this.reloj();
    const previo = this.store.lead(tel);
    if (previo) {
      this.store.log(tel, "lead_duplicado", JSON.stringify(datos));
      return previo; // nunca se borran ni se pisan leads
    }
    const lead = this.store.crearLead(
      tel,
      {
        dueno: datos.dueno ?? this.cfg.DUENO_POR_DEFECTO,
        nombre: datos.nombre,
        origen: datos.origen,
        formulario: datos.formulario?.trim() || null,
        anuncio: datos.anuncio,
      },
      ahora,
    );
    if (datos.origen === "abandonado") {
      // Pendiente de Mario si se permite escribir a abandonados.
      this.store.actualizar(tel, { pausado: 1, motivo_pausa: "abandonado: pendiente de Mario" });
      await this.escalar(this.store.lead(tel)!, {
        categoria: "otro",
        motivo: "Lead abandonado (dejó su teléfono sin enviar el formulario). Falta definir si se le escribe.",
        propuesta: "Dejaste tus datos y quise escribirte. ¿Qué te hizo buscarnos?",
      });
      return this.store.lead(tel)!;
    }
    // Primer contacto: lo hace el ciclo de seguimiento en el primer momento permitido.
    this.store.actualizar(tel, { proximo_toque: siguienteMomentoPermitido(ahora, this.horario, false).toISOString() });
    return lead;
  }

  // =====================================================================
  // Ciclo periódico
  // =====================================================================

  async tick(): Promise<void> {
    const ahora = this.reloj();
    if (this.cfg.MODO === "pausado") return;

    const limite = new Date(ahora.getTime() - this.cfg.DEBOUNCE_SEGUNDOS * 1000);
    for (const lead of this.store.leadsConPendientes(limite)) {
      if (!dentroDeHorario(ahora, this.horario)) break;
      if (!this.hayCupo(ahora)) break;
      await this.conCandado(lead.telefono, () => this.turno(lead.telefono, "respuesta"));
    }

    for (const lead of this.store.leadsConToqueVencido(ahora)) {
      if (!this.hayCupo(ahora)) break;
      await this.conCandado(lead.telefono, () => this.seguimiento(lead.telefono));
    }

    this.reglasDePaso(ahora);
  }

  private hayCupo(ahora: Date): boolean {
    return this.store.contarSalientesUltimaHora(ahora) < this.cfg.MAX_MENSAJES_HORA;
  }

  private async conCandado(tel: string, fn: () => Promise<void>): Promise<void> {
    if (this.ocupados.has(tel)) return;
    this.ocupados.add(tel);
    try {
      await fn();
    } catch (e) {
      console.error(`Error en turno de ${tel}`, e);
      this.store.log(tel, "error_turno", String(e));
    } finally {
      this.ocupados.delete(tel);
    }
  }

  /** 14 días sin respuesta: Intake -> Not qualified. 21 días: Qualified -> Lost. */
  private reglasDePaso(ahora: Date): void {
    for (const l of this.store.todos()) {
      if (l.dueno === "VERO" || l.pausado) continue;
      const ref = new Date(l.ultimo_in ?? l.creado).getTime();
      const dias = (ahora.getTime() - ref) / DIA;
      const salientes = this.store.mensajes(l.telefono, 500).filter((m) => m.direccion !== "in" && m.direccion !== "nota").length;
      if (l.etapa === "Intake" && dias >= 14 && salientes > 1) {
        this.store.actualizar(l.telefono, { etapa: "Not qualified" });
        this.store.log(l.telefono, "etapa_auto", "Intake -> Not qualified (14 días sin respuesta)");
      } else if (l.etapa === "Qualified" && dias >= 21 && salientes > 1) {
        this.store.actualizar(l.telefono, { etapa: "Lost" });
        this.store.log(l.telefono, "etapa_auto", "Qualified -> Lost (21 días sin respuesta)");
      }
    }
  }

  // =====================================================================
  // Turnos del agente
  // =====================================================================

  private async turno(tel: string, modo: "respuesta" | "seguimiento"): Promise<void> {
    const lead = this.store.lead(tel);
    if (!lead || lead.pausado || lead.dueno === "VERO") {
      if (lead) this.store.actualizar(tel, { pendiente_desde: null });
      return;
    }
    const ahora = this.reloj();
    const mensajes = this.store.mensajes(tel);
    const contexto = armarContexto(lead, mensajes, {
      modo,
      ahora,
      tz: this.cfg.TZ_NEGOCIO,
      presentacion: this.presentacion(lead),
    });

    const d = await this.agente.decidir(contexto);
    this.store.log(tel, "decision", JSON.stringify(d));
    this.store.actualizar(tel, { pendiente_desde: null });
    await this.aplicar(lead, d, modo);
  }

  private async aplicar(lead: Lead, d: Decision, modo: "respuesta" | "seguimiento"): Promise<void> {
    const tel = lead.telefono;
    const ahora = this.reloj();

    // Datos y etapa
    for (const x of d.datos) {
      if (x.campo === "nombre") this.store.actualizar(tel, { nombre: x.valor });
      else if (x.campo === "ciudad") this.store.actualizar(tel, { ciudad: x.valor });
      else if (x.campo === "nota") this.store.actualizar(tel, { notas: [lead.notas, x.valor].filter(Boolean).join(" | ") });
      else if (x.campo === "aprendizaje") this.store.log(tel, "aprendizaje", x.valor);
    }
    const actual = this.store.lead(tel)!;
    const etapa = etapaFinal(actual.etapa, d.etapa);
    if (etapa !== actual.etapa) this.store.actualizar(tel, { etapa });
    if (d.paso) this.store.actualizar(tel, { paso: d.paso });

    if (d.rechazo) {
      await this.escalar(this.store.lead(tel)!, {
        categoria: "otro",
        motivo: "El modelo no pudo generar una respuesta para este chat. Revísalo tú.",
        propuesta: null,
      });
      return;
    }

    if (d.noResponder && !d.mensajes.length) {
      this.marcarLeidoUltimo(tel);
      return;
    }

    // Escalación: se pausa y se manda la propuesta a Mario.
    if (d.escalacion) {
      await this.escalar(this.store.lead(tel)!, {
        categoria: d.escalacion.categoria,
        motivo: d.escalacion.motivo,
        propuesta: d.escalacion.propuesta,
        pausar: !d.escalacion.enviarTambien,
      });
      if (!d.escalacion.enviarTambien) return; // se deja sin responder y sin leer
    }

    // Modo aprobación: todo pasa por Mario.
    if (this.cfg.MODO === "aprobacion" && (d.mensajes.length || d.enviarVideo)) {
      const propuesta = [...d.mensajes, d.enviarVideo ? `[video] ${this.cfg.VIDEO_EDUCATIVO_URL}` : ""].filter(Boolean).join("\n\n");
      await this.escalar(this.store.lead(tel)!, { categoria: "aprobacion", motivo: "Respuesta para aprobar", propuesta });
      return;
    }

    let enviados = 0;
    for (const m of d.mensajes) {
      await this.enviarTexto(this.store.lead(tel)!, m, "agente");
      enviados++;
    }
    if (d.enviarVideo && !actual.video_enviado && this.cfg.VIDEO_EDUCATIVO_URL) {
      await this.enviarTexto(this.store.lead(tel)!, this.cfg.VIDEO_EDUCATIVO_URL, "agente");
      this.store.actualizar(tel, { video_enviado: 1 });
      enviados++;
    }
    if (!enviados) return;

    const l = this.store.lead(tel)!;
    const cambios: Partial<Lead> = {};
    if (l.paso === "nuevo") cambios.paso = "contactado";
    if (l.paso === "ofrecido") cambios.horario_ofrecido = 1;
    const intentos = modo === "seguimiento" ? l.intentos_sin_respuesta + 1 : 0;
    cambios.intentos_sin_respuesta = intentos;
    const paso = (cambios.paso ?? l.paso) as Paso;
    const prox = ETAPAS_CERRADAS.has(l.etapa) || PASOS_SIN_SEGUIMIENTO.includes(paso) ? null : proximoToque(paso, intentos, ahora, this.horario);
    cambios.proximo_toque = prox?.toISOString() ?? null;
    this.store.actualizar(tel, cambios);
    this.marcarLeidoUltimo(tel);
  }

  /** Toque de seguimiento (o primer contacto de un lead de formulario). */
  private async seguimiento(tel: string): Promise<void> {
    const lead = this.store.lead(tel);
    if (!lead) return;
    const ahora = this.reloj();
    if (lead.pausado || lead.dueno === "VERO" || ETAPAS_CERRADAS.has(lead.etapa) || PASOS_SIN_SEGUIMIENTO.includes(lead.paso)) {
      this.store.actualizar(tel, { proximo_toque: null });
      return;
    }
    if (lead.humano_hasta && new Date(lead.humano_hasta) > ahora) {
      this.store.actualizar(tel, { proximo_toque: lead.humano_hasta });
      return;
    }

    // Dentro de las 24 h desde su último mensaje: el agente redacta un toque a medida.
    if (ventanaAbierta(lead.ultimo_in, ahora)) {
      return this.turno(tel, "seguimiento");
    }

    // Fuera de la ventana: solo plantillas aprobadas por Meta.
    const nombre = (lead.nombre ?? "").split(" ")[0] || "hola";
    let plantilla: string;
    let params: string[];
    if (lead.paso === "nuevo") {
      const pres = this.presentacion(lead);
      if (!pres) {
        this.store.actualizar(tel, { pausado: 1, motivo_pausa: "presentación de Dani pendiente", proximo_toque: null });
        await this.escalar(this.store.lead(tel)!, {
          categoria: "presentacion_dani",
          motivo: "Primer contacto en chat de Dani: falta definir cómo presentarse.",
          propuesta: null,
        });
        return;
      }
      if (lead.formulario) {
        plantilla = this.cfg.PLANTILLA_PRIMER_CONTACTO;
        params = [nombre, pres, resumir(lead.formulario, 120)];
      } else {
        plantilla = this.cfg.PLANTILLA_PRIMER_CONTACTO_SIN_RESPUESTA;
        params = [nombre, pres];
      }
    } else {
      // Varias plantillas por paso, rotando: cada vuelta trae algo distinto (nunca el mismo mensaje).
      const lista =
        lead.paso === "contactado"
          ? this.cfg.PLANTILLA_SEGUIMIENTO_CONTACTADO
          : lead.paso === "ofrecido" || lead.paso === "comprometido"
            ? this.cfg.PLANTILLA_SEGUIMIENTO_OFRECIDO
            : this.cfg.PLANTILLA_SEGUIMIENTO_CONVERSANDO;
      const opciones = lista.split(",").map((x) => x.trim()).filter(Boolean);
      plantilla = opciones[lead.intentos_sin_respuesta % opciones.length];
      params = [nombre];
    }

    const waId = await this.wa.enviarPlantilla(tel, plantilla, params);
    this.store.guardarMensaje({
      telefono: tel,
      direccion: "out",
      tipo: "template",
      texto: `[plantilla ${plantilla}] ${params.join(" | ")}`,
      wa_id: waId || null,
      autor: "plantilla",
      ts: ahora.toISOString(),
    });
    const primerContacto = lead.paso === "nuevo";
    const paso: Paso = primerContacto ? "contactado" : lead.paso;
    const intentos = primerContacto ? 0 : lead.intentos_sin_respuesta + 1;
    const prox = proximoToque(paso, intentos, ahora, this.horario);
    this.store.actualizar(tel, {
      paso,
      intentos_sin_respuesta: intentos,
      ultimo_out: ahora.toISOString(),
      proximo_toque: prox?.toISOString() ?? null,
    });
  }

  // =====================================================================
  // Envío, escalación y notificaciones
  // =====================================================================

  private async enviarTexto(lead: Lead, texto: string, autor: string): Promise<void> {
    const waId = await this.wa.enviarTexto(lead.telefono, texto);
    this.store.guardarMensaje({
      telefono: lead.telefono,
      direccion: "out",
      tipo: "text",
      texto,
      wa_id: waId || null,
      autor,
      ts: this.reloj().toISOString(),
    });
    this.store.actualizar(lead.telefono, { ultimo_out: this.reloj().toISOString() });
  }

  private marcarLeidoUltimo(tel: string): void {
    const ultimo = [...this.store.mensajes(tel, 10)].reverse().find((m) => m.direccion === "in" && m.wa_id);
    if (ultimo?.wa_id) this.wa.marcarLeido(ultimo.wa_id).catch(() => {});
  }

  private async escalar(
    lead: Lead,
    e: { categoria: string; motivo: string; propuesta: string | null; pausar?: boolean },
  ): Promise<Escalacion> {
    const esc = this.store.crearEscalacion({
      telefono: lead.telefono,
      categoria: e.categoria,
      motivo: e.motivo,
      propuesta: e.propuesta,
    });
    if (e.pausar !== false) {
      this.store.actualizar(lead.telefono, {
        pausado: 1,
        motivo_pausa: lead.motivo_pausa ?? `escalación #${esc.id} (${e.categoria})`,
        pendiente_desde: null,
      });
    }
    const urgente = e.categoria === "riesgo" || e.categoria === "caliente";
    const lineas = [
      `${urgente ? "URGENTE " : ""}[#${esc.id}] ${e.categoria.toUpperCase()} | +${lead.telefono}${lead.nombre ? ` (${lead.nombre})` : ""} | chat de ${lead.dueno}`,
      `Motivo: ${e.motivo}`,
      e.propuesta ? `Propuesta:\n${e.propuesta}` : null,
      e.propuesta
        ? `Responde: OK ${esc.id} | EDITAR ${esc.id} <texto> | IGNORAR ${esc.id}`
        : `Cuando lo atiendas: IGNORAR ${esc.id} (y REANUDAR ${lead.telefono} si el agente debe seguir)`,
    ];
    await this.notificar(lineas.filter(Boolean).join("\n"));
    return esc;
  }

  async notificar(texto: string): Promise<void> {
    for (const admin of this.cfg.notificarA) {
      try {
        const abierta = ventanaAbierta(this.ultimoInAdmin.get(admin) ?? null, this.reloj());
        if (abierta) await this.wa.enviarTexto(admin, texto);
        else await this.wa.enviarPlantilla(admin, this.cfg.PLANTILLA_ALERTA, [paraPlantilla(texto)]);
      } catch (e) {
        try {
          await this.wa.enviarPlantilla(admin, this.cfg.PLANTILLA_ALERTA, [paraPlantilla(texto)]);
        } catch (e2) {
          console.error("No se pudo notificar a", admin, e2);
        }
      }
    }
    this.store.log(null, "notificacion", texto);
  }

  // =====================================================================
  // Comandos de Mario / Dani por WhatsApp
  // =====================================================================

  async comandoAdmin(de: string, textoCrudo: string): Promise<string> {
    const texto = textoCrudo.trim();
    const [cmdRaw, ...resto] = texto.split(/\s+/);
    const cmd = (cmdRaw ?? "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const responder = async (r: string) => {
      await this.wa.enviarTexto(de, r).catch(() => {});
      return r;
    };

    try {
      switch (cmd) {
        case "OK":
        case "EDITAR": {
          const id = Number(resto[0]);
          const esc = this.store.escalacion(id);
          if (!esc || esc.estado !== "pendiente") return responder(`No hay escalación pendiente #${resto[0]}.`);
          const cuerpo = cmd === "OK" ? esc.propuesta : texto.replace(/^\S+\s+\S+\s*/, "");
          if (!cuerpo) return responder(`La escalación #${id} no tiene propuesta. Usa EDITAR ${id} <texto>.`);
          const lead = this.store.lead(esc.telefono)!;
          for (const parte of cuerpo.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).slice(0, 2)) {
            await this.enviarTexto(lead, parte, cmd === "OK" ? "agente_aprobado" : "mario");
          }
          this.store.cerrarEscalacion(id, cmd === "OK" ? "enviada" : "editada");
          this.reanudarSiNoQuedan(esc.telefono);
          const l = this.store.lead(esc.telefono)!;
          const prox = proximoToque(l.paso, 0, this.reloj(), this.horario);
          this.store.actualizar(esc.telefono, { intentos_sin_respuesta: 0, proximo_toque: prox?.toISOString() ?? null });
          this.marcarLeidoUltimo(esc.telefono);
          return responder(`Enviado a +${esc.telefono}.`);
        }
        case "IGNORAR": {
          const id = Number(resto[0]);
          const esc = this.store.escalacion(id);
          if (!esc) return responder(`No existe la escalación #${resto[0]}.`);
          this.store.cerrarEscalacion(id, "ignorada");
          this.reanudarSiNoQuedan(esc.telefono, esc.categoria !== "riesgo");
          return responder(
            `#${id} cerrada.${esc.categoria === "riesgo" ? ` El chat sigue en pausa por riesgo: REANUDAR ${esc.telefono} cuando corresponda.` : ""}`,
          );
        }
        case "PAUSA":
        case "PAUSAR": {
          const tel = normalizarTelefono(resto[0] ?? "");
          if (!this.store.lead(tel)) return responder(`No conozco +${tel}.`);
          this.store.actualizar(tel, { pausado: 1, motivo_pausa: "pausado por Mario", pendiente_desde: null });
          return responder(`+${tel} en pausa.`);
        }
        case "REANUDAR": {
          const tel = normalizarTelefono(resto[0] ?? "");
          if (!this.store.lead(tel)) return responder(`No conozco +${tel}.`);
          this.reanudar(tel);
          return responder(`+${tel} reanudado: el agente vuelve a atenderlo.`);
        }
        case "DUENO": {
          const tel = normalizarTelefono(resto[0] ?? "");
          const dueno = (resto[1] ?? "").toUpperCase();
          if (!["MARIO", "DANI", "VERO"].includes(dueno)) return responder("Uso: DUEÑO <teléfono> MARIO|DANI|VERO");
          if (!this.store.lead(tel)) this.store.crearLead(tel, { dueno: dueno as Dueno, origen: "manual" });
          const l = this.store.lead(tel)!;
          const cambios: Partial<Lead> = { dueno: dueno as Dueno };
          if (l.motivo_pausa?.startsWith("chat iniciado desde la app")) Object.assign(cambios, { pausado: 0, motivo_pausa: null });
          this.store.actualizar(tel, cambios);
          return responder(`+${tel} ahora es chat de ${dueno}.`);
        }
        case "ETAPA": {
          const tel = normalizarTelefono(resto[0] ?? "");
          const etapa = resto.slice(1).join(" ");
          const valida = ETAPAS.find((e) => e.toLowerCase() === etapa.toLowerCase());
          if (!valida || !this.store.lead(tel)) return responder(`Uso: ETAPA <teléfono> ${ETAPAS.join(" | ")}`);
          this.store.actualizar(tel, { etapa: valida });
          return responder(`+${tel}: etapa ${valida}.`);
        }
        case "PAGADO": {
          // PAGADO 0991234567 2026-11-27 15:00
          const tel = normalizarTelefono(resto[0] ?? "");
          const lead = this.store.lead(tel);
          if (!lead) return responder(`No conozco +${tel}.`);
          const fecha = resto[1];
          const hora = resto[2];
          this.store.actualizar(tel, { etapa: "Agendo sesion Evaluacion", paso: "agendado", proximo_toque: null });
          let extra = "";
          if (fecha && hora && this.calendario) {
            const link = await this.calendario.crearEvaluacion(
              `${fecha}T${hora}:00-05:00`,
              `Evaluación ${lead.nombre ?? ""} +${tel}`.trim(),
              `Lead de ${lead.dueno}. Origen: ${lead.origen ?? "-"}. Notas: ${lead.notas ?? "-"}`,
            );
            extra = ` Evento creado: ${link}`;
          }
          return responder(`+${tel} marcado como Agendó sesión Evaluación.${extra}`);
        }
        case "CONVERTIDO": {
          const tel = normalizarTelefono(resto[0] ?? "");
          if (!this.store.lead(tel)) return responder(`No conozco +${tel}.`);
          this.store.actualizar(tel, { etapa: "Converted", paso: "cerrado", proximo_toque: null });
          return responder(`+${tel} marcado como Converted.`);
        }
        case "PENDIENTES": {
          const p = this.store.escalacionesPendientes();
          if (!p.length) return responder("No hay escalaciones pendientes.");
          return responder(p.slice(0, 15).map((e) => `#${e.id} ${e.categoria} +${e.telefono}: ${resumir(e.motivo, 80)}`).join("\n"));
        }
        case "ESTADO": {
          const tel = normalizarTelefono(resto[0] ?? "");
          const l = this.store.lead(tel);
          if (!l) return responder(`No conozco +${tel}.`);
          return responder(
            `+${tel} ${l.nombre ?? ""}\nDueño: ${l.dueno} | Etapa: ${l.etapa} | Paso: ${l.paso}\nPausado: ${l.pausado ? `sí (${l.motivo_pausa})` : "no"}\nPróximo toque: ${l.proximo_toque ?? "-"}`,
          );
        }
        default:
          return responder(
            [
              "Comandos:",
              "OK <n> | EDITAR <n> <texto> | IGNORAR <n>",
              "PENDIENTES | ESTADO <tel>",
              "PAUSA <tel> | REANUDAR <tel>",
              "DUEÑO <tel> MARIO|DANI|VERO",
              "ETAPA <tel> <etapa>",
              "PAGADO <tel> [AAAA-MM-DD HH:MM] | CONVERTIDO <tel>",
            ].join("\n"),
          );
      }
    } catch (e) {
      return responder(`Error: ${(e as Error).message}`);
    }
  }

  private reanudarSiNoQuedan(tel: string, reanudar = true): void {
    const quedan = this.store.escalacionesPendientes().some((e) => e.telefono === tel);
    const l = this.store.lead(tel);
    if (!quedan && reanudar && l && !l.motivo_pausa?.startsWith("riesgo")) {
      this.reanudar(tel);
    }
  }

  /** Quita la pausa y, si el lead escribió mientras tanto, deja su mensaje pendiente para el agente. */
  private reanudar(tel: string): void {
    const ultimo = this.store.mensajes(tel, 1)[0];
    this.store.actualizar(tel, {
      pausado: 0,
      motivo_pausa: null,
      pendiente_desde: ultimo?.direccion === "in" ? this.reloj().toISOString() : null,
    });
  }
}

function resumir(t: string, n = 200): string {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Los parámetros de plantilla no aceptan saltos de línea ni más de 4 espacios seguidos. */
function paraPlantilla(t: string): string {
  return resumir(t.replace(/\n+/g, " / "), 900);
}
