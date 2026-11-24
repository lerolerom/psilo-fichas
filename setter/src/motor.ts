import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { normalizarTelefono } from "./config.js";
import type { Dueno, Escalacion, Lead, Mensaje, Store } from "./db.js";
import { ETAPAS } from "./db.js";
import type { EventoWA, WhatsApp } from "./whatsapp.js";
import type { AgenteSetter, Decision } from "./agent/agente.js";
import { etapaFinal } from "./agent/agente.js";
import { armarContexto, hechos } from "./contexto.js";
import { detectarRiesgo, mensajeContencion } from "./riesgo.js";
import type { Transcriptor } from "./transcriptor.js";
import type { Conversiones } from "./meta.js";
import {
  type Azar,
  DIA,
  desdeLocal,
  enFranjaSeguimiento,
  diasDesde,
  esperaLectura,
  formatoCita,
  partesLocales,
  proximoToque,
  tiempoEscritura,
  ventanaAbierta,
} from "./tiempo.js";

export interface CalendarioEscritura {
  libre?(inicioIso: string, minutos: number): Promise<boolean>;
  crearEvaluacion(
    inicioIso: string,
    titulo: string,
    descripcion: string,
    minutos?: number,
    enLinea?: boolean,
  ): Promise<{ link: string; meet: string | null }>;
}

export interface OpcionesMotor {
  reloj?: () => Date;
  azar?: Azar;
  dormir?: (ms: number) => Promise<void>;
  transcriptor?: Transcriptor | null;
  conversiones?: Conversiones | null;
}

/** Fila de la comparación del modo sombra: lo que propuso el agente frente a lo que se envió de verdad. */
export interface FilaComparacion {
  telefono: string;
  nombre: string | null;
  modo: string;
  lead: string[]; // mensajes del lead que motivaron la propuesta
  propuesta: string[]; // mensajes que habría enviado el agente
  accion: string | null; // escalación, datos de pago, comprobante, plantilla, etc.
  etapa: string | null;
  real: { quien: string; texto: string }[]; // lo que se envió de verdad (rondas, Mario)
  minutosReal: number | null; // cuánto tardó la respuesta real
  minutosAgente: number | null; // cuánto habría tardado el agente (con la lectura configurada)
}

type Entrante = Extract<EventoWA, { tipo: "entrante" }>;
type Eco = Extract<EventoWA, { tipo: "eco" }>;
type Modo = "respuesta" | "seguimiento" | "recordatorio";

const SIN_SEGUIMIENTO = new Set(["Converted", "Agendo sesion Evaluacion"]);
/** Separa los mensajes de una propuesta (no aparece dentro de un mensaje normal). */
const SEPARADOR = "\n---\n";
const MEDIA_VISIBLE = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;

export class Motor {
  private ocupados = new Set<string>(); // leads con un turno en curso
  private ultimoInAdmin = new Map<string, string>();
  private reloj: () => Date;
  private azar: Azar;
  private dormir: (ms: number) => Promise<void>;
  private transcriptor: Transcriptor | null;
  private conversiones: Conversiones | null;

  constructor(
    private cfg: Config,
    private store: Store,
    private wa: WhatsApp,
    private agente: AgenteSetter,
    private calendario: CalendarioEscritura | null,
    opts: OpcionesMotor = {},
  ) {
    this.reloj = opts.reloj ?? (() => new Date());
    this.azar = opts.azar ?? Math.random;
    this.dormir = opts.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.transcriptor = opts.transcriptor ?? null;
    this.conversiones = opts.conversiones ?? null;
    // Cada cambio de etapa se encola para Meta (en modo sombra no: las etapas reales las lleva aún el sistema anterior).
    this.store.onCambioEtapa = (tel, _anterior, nueva) => {
      if (this.conversiones && this.cfg.MODO !== "sombra") this.store.encolarEventoMeta(tel, nueva, this.reloj());
    };
  }

  private get sombra(): boolean {
    return this.cfg.MODO === "sombra";
  }

  private lectura(texto: string): number {
    if (this.cfg.MODO === "sombra") return 60_000; // en sombra se propone enseguida para poder comparar
    return esperaLectura(texto.length, { min: this.cfg.LECTURA_MIN_MINUTOS, max: this.cfg.LECTURA_MAX_MINUTOS, azar: this.azar });
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
          // Un mensaje a un lead que no llegó: Mario debe saberlo (por ejemplo, ventana de 24 h cerrada).
          if (!this.cfg.adminNumeros.includes(ev.para)) {
            await this.notificar(`No se pudo entregar un mensaje a +${ev.para} (${ev.error ?? "error de WhatsApp"}). Revisa el chat y escríbele desde la app si hace falta.`);
          }
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

  private nuestros(tel: string): Mensaje[] {
    return this.store.mensajes(tel, 500).filter((m) => m.direccion === "out" || m.direccion === "eco");
  }

  private async entrante(ev: Entrante): Promise<void> {
    const ahora = this.reloj();

    if (this.cfg.adminNumeros.includes(ev.de) && !ev.historial) {
      this.ultimoInAdmin.set(ev.de, ahora.toISOString());
      await this.comandoAdmin(ev.de, ev.texto);
      return;
    }

    let lead = this.store.lead(ev.de);
    if (!lead) {
      const origen = ev.historial ? "app" : ev.referral ? (ev.referral.source_type === "ad" ? "anuncio" : "referral") : "directo";
      lead = this.store.crearLead(
        ev.de,
        { dueno: this.cfg.DUENO_POR_DEFECTO, nombre: null, origen, anuncio: ev.referral?.headline ?? ev.referral?.source_url ?? null },
        ahora,
      );
      if (ev.nombrePerfil) this.store.actualizar(ev.de, { notas: `Nombre de perfil de WhatsApp: ${ev.nombrePerfil}` });
    }
    if (ev.referral?.ctwa_clid && !lead.ctwa_clid) {
      this.store.actualizar(ev.de, { ctwa_clid: ev.referral.ctwa_clid, anuncio: lead.anuncio ?? ev.referral.headline ?? null });
    }

    if (this.store.existeMensaje(ev.waId)) return; // reintento de Meta

    // El audio se transcribe antes de guardarlo, para que ningún turno lo vea vacío.
    let texto = ev.texto;
    if (ev.clase === "audio" && ev.mediaId && !ev.historial) texto = (await this.transcribir(ev.mediaId)) ?? ev.texto;

    const nuevo = this.store.guardarMensaje({
      telefono: ev.de,
      direccion: "in",
      tipo: ev.clase,
      texto,
      wa_id: ev.waId,
      autor: "lead",
      ts: ev.ts.toISOString(),
    });
    if (!nuevo) return;

    // Historial sincronizado al activar la coexistencia: solo se guarda.
    if (ev.historial) {
      this.store.actualizar(ev.de, { historial_incompleto: 1 });
      return;
    }

    if (ev.clase !== "audio" && ev.mediaId && this.wa.descargarMedia) await this.guardarAdjunto(ev.waId, ev.mediaId);
    lead = this.store.lead(ev.de)!; // el estado pudo cambiar durante las descargas
    if (ev.formulario) {
      this.store.actualizar(ev.de, { formulario: [lead.formulario, ev.formulario].filter(Boolean).join("\n"), origen: lead.origen ?? "formulario" });
    }

    // Chats de Vero: no se leen ni se contestan, y quedan como no leídos.
    // Única excepción: una señal de riesgo se avisa a los fundadores (sin escribirle al lead).
    if (lead.dueno === "VERO") {
      if (detectarRiesgo(texto)) {
        await this.notificar(`URGENTE: posible señal de riesgo en un chat de VERO (+${ev.de}). No se respondió nada. Mensaje: "${resumir(texto)}"`);
      }
      return;
    }

    // Si había dicho que no y vuelve a escribir, la conversación se retoma.
    const cambios: Partial<Lead> = { ultimo_in: ahora.toISOString(), intentos_sin_respuesta: 0, proximo_toque: null, dijo_no: 0 };
    if (lead.paso === "contactado" || lead.paso === "nuevo") cambios.paso = "abrio";

    // Riesgo: antes que cualquier otra cosa y a cualquier hora, sin pasar por el agente de ventas.
    const riesgo = detectarRiesgo(texto);
    if (riesgo && this.sombra) {
      this.store.guardarSombra({
        telefono: ev.de,
        modo: "riesgo",
        ts_lead: ev.ts.toISOString(),
        ts_propuesta: ahora.toISOString(),
        decision: JSON.stringify({
          mensajes: riesgo === "alto" ? [{ texto: mensajeContencion(lead.nombre) }] : [],
          accion: `Riesgo ${riesgo}: chat en pausa y alerta urgente a Mario`,
        }),
        contexto_hasta: ev.ts.toISOString(),
      });
      this.store.actualizar(ev.de, cambios);
      return;
    }
    if (riesgo) {
      this.store.actualizar(ev.de, { ...cambios, pausado: 1, motivo_pausa: `riesgo ${riesgo}`, pendiente_desde: null });
      const lead2 = this.store.lead(ev.de)!;
      let contencion = "No se respondió nada.";
      if (riesgo === "alto" && this.cfg.MODO !== "pausado") {
        // Riesgo: sin tiempo de lectura, se contesta de inmediato. Si el envío falla, Mario igual se entera.
        try {
          await this.enviarTexto(lead2, mensajeContencion(lead2.nombre), { autor: "sistema", tipo: "otro", respondeA: ev.ts.toISOString() });
          contencion = "Se envió el mensaje de contención con 171 opción 6 y 911.";
        } catch (e) {
          contencion = `NO se pudo enviar el mensaje de contención (${String(e).slice(0, 120)}): escríbele tú ya.`;
        }
      }
      await this.escalar(lead2, {
        categoria: "riesgo",
        motivo: `${riesgo === "alto" ? "Posible riesgo de autolesión" : "Señal ambigua de riesgo"}. ${contencion} Mensaje${ev.clase === "audio" ? " (audio transcrito)" : ""}: "${texto}"`,
        propuesta: null,
      });
      return;
    }

    if (lead.pausado) {
      this.store.actualizar(ev.de, cambios);
      if (lead.motivo_pausa?.startsWith("riesgo")) {
        await this.notificar(`URGENTE: +${ev.de}${lead.nombre ? ` (${lead.nombre})` : ""}, caso de riesgo, volvió a escribir: "${resumir(texto || `[${ev.clase}]`)}"`);
      }
      return; // su caso ya está para Mario; aparece en el reporte diario
    }

    // Tiempo de "lectura": se contesta como lo haría una persona, no al instante. Si el lead sigue escribiendo,
    // se espera al menos un minuto desde su último mensaje. Si Mario acaba de escribir desde la app, se le da margen.
    let objetivo: Date;
    if (lead.pendiente_desde && lead.responder_despues) {
      // Ya estaba leyendo una ráfaga de mensajes: se respeta ese tiempo, pero al menos un minuto desde el último.
      const previo = new Date(lead.responder_despues);
      const minimo = new Date(ahora.getTime() + 60_000);
      objetivo = previo > minimo ? previo : minimo;
    } else {
      objetivo = new Date(ahora.getTime() + this.lectura(texto));
    }
    if (lead.humano_hasta && new Date(lead.humano_hasta) > objetivo) objetivo = new Date(lead.humano_hasta);
    this.store.actualizar(ev.de, {
      ...cambios,
      pendiente_desde: lead.pendiente_desde ?? ahora.toISOString(),
      responder_despues: objetivo.toISOString(),
    });
  }

  private async transcribir(mediaId: string): Promise<string | null> {
    if (!this.transcriptor || !this.wa.descargarMedia) return null;
    try {
      const m = await this.wa.descargarMedia(mediaId);
      if (!m) return null;
      return await this.transcriptor.transcribir(m.data, m.mime);
    } catch (e) {
      this.store.log(null, "transcripcion_error", String(e));
      return null;
    }
  }

  private async guardarAdjunto(waId: string, mediaId: string): Promise<void> {
    try {
      const m = await this.wa.descargarMedia!(mediaId);
      if (!m) return;
      const mime = m.mime.split(";")[0].trim();
      const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1] ?? "bin";
      const dir = path.join(path.dirname(this.cfg.DB_PATH === ":memory:" ? "./data/x" : this.cfg.DB_PATH), "media");
      fs.mkdirSync(dir, { recursive: true });
      const ruta = path.join(dir, `${waId.replace(/[^\w.-]/g, "_")}.${ext}`);
      fs.writeFileSync(ruta, m.data);
      this.store.ponerMedia(waId, `${mime}|${ruta}`);
    } catch (e) {
      this.store.log(null, "media_error", String(e));
    }
  }

  /** Mensaje escrito por el equipo desde la app WhatsApp Business (coexistencia). */
  private async eco(ev: Eco): Promise<void> {
    const ahora = this.reloj();
    let lead = this.store.lead(ev.para);
    const iniciadoDesdeApp = !lead && !ev.historial;
    if (!lead) {
      // Chat iniciado desde la app: no sabemos de quién es. Por seguridad, el agente no lo toca hasta que Mario diga.
      lead = this.store.crearLead(ev.para, { dueno: this.cfg.DUENO_POR_DEFECTO, origen: "app" }, ahora);
      if (iniciadoDesdeApp) this.store.actualizar(ev.para, { pausado: 1, motivo_pausa: "chat iniciado desde la app: asignar dueño con DUEÑO" });
    }
    const primeroNuestro = this.nuestros(ev.para).length === 0;
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
    if (ev.historial) {
      this.store.actualizar(ev.para, { historial_incompleto: 1 });
      return;
    }
    if (iniciadoDesdeApp) {
      await this.escalar(this.store.lead(ev.para)!, {
        categoria: "asignar_dueno",
        motivo: `Chat nuevo iniciado desde la app ("${resumir(ev.texto, 80)}"). El agente no lo atiende hasta que le asignes dueño: DUEÑO ${ev.para} MARIO|DANI|VERO.`,
        propuesta: null,
      });
      return;
    }
    // Mario contestó desde la app: ese mensaje queda en la conversación (el agente lo lee y sigue desde ahí).
    // Lo pendiente se da por atendido y, si el lead responde enseguida, se le da a Mario unos minutos de margen.
    void primeroNuestro;
    // ¿Era un seguimiento que dejó el sistema para las rondas de Chrome? (ya contado como toque)
    this.store.db.prepare("UPDATE para_chrome SET estado = 'enviado' WHERE telefono = ? AND estado = 'pendiente'").run(ev.para);
    const l = this.store.lead(ev.para)!;
    this.store.actualizar(ev.para, {
      humano_hasta: new Date(ahora.getTime() + this.cfg.ESPERA_TRAS_MARIO_MINUTOS * 60_000).toISOString(),
      // En sombra se mantiene lo pendiente para que el agente igual proponga (y se compare con esto).
      ...(this.sombra ? {} : { pendiente_desde: null, responder_despues: null }),
      ultimo_out: ahora.toISOString(),
      proximo_toque: this.calcularProximoToque(l, ahora),
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
    leadgenId?: string;
  }): Promise<Lead> {
    const tel = normalizarTelefono(datos.telefono);
    const ahora = this.reloj();
    const previo = this.store.lead(tel);
    if (previo) {
      this.store.log(tel, "lead_duplicado", JSON.stringify(datos));
      return previo; // nunca se borran ni se pisan leads
    }
    this.store.crearLead(
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
    // Primer contacto (abandonados incluidos: "estos leads sí se escriben"), tras un tiempo de "lectura".
    this.store.actualizar(tel, { leadgen_id: datos.leadgenId ?? null, proximo_toque: new Date(ahora.getTime() + this.lectura(datos.formulario ?? "")).toISOString() });
    return this.store.lead(tel)!;
  }

  // =====================================================================
  // Ciclo periódico
  // =====================================================================

  async tick(): Promise<void> {
    const ahora = this.reloj();
    await this.quizasReporteDiario(ahora);
    if (this.cfg.MODO === "pausado") return;
    const tareas: Promise<void>[] = [];

    // 1) Respuestas, a cualquier hora, cuando pasó el tiempo de "lectura".
    for (const lead of this.store.leadsListosParaResponder(ahora)) {
      if (!this.hayCupo(ahora)) break;
      if (!this.sombra && lead.humano_hasta && new Date(lead.humano_hasta) > ahora) continue;
      tareas.push(this.conCandado(lead.telefono, () => this.turno(lead.telefono, "respuesta")));
    }

    // 2) Recordatorios de cita (desde las 09:00) y seguimientos (la hora ya viene elegida dentro de las franjas).
    const hora = partesLocales(ahora, this.cfg.TZ_NEGOCIO).hora;
    if (hora >= 9 && hora < 20) await this.recordatoriosDeCita(ahora);
    for (const lead of this.store.leadsConToqueVencido(ahora)) {
      if (!this.hayCupo(ahora)) break;
      tareas.push(this.conCandado(lead.telefono, () => this.seguimiento(lead.telefono)));
    }
    await Promise.all(tareas);

    if (!this.sombra) this.reglasDePaso(ahora);
    await this.enviarEventosMeta();
  }

  /** Envía a Meta los cambios de etapa encolados (con reintentos). */
  private async enviarEventosMeta(): Promise<void> {
    if (!this.conversiones || this.sombra) return;
    for (const e of this.store.eventosMetaPendientes()) {
      const lead = this.store.lead(e.telefono);
      if (!lead) {
        this.store.marcarEventoMeta(e.id, true);
        continue;
      }
      try {
        const r = await this.conversiones.enviar(lead, e.etapa, new Date(e.ts));
        this.store.marcarEventoMeta(e.id, true);
        if (r === "enviado") this.store.log(e.telefono, "meta_evento", e.etapa);
      } catch (err) {
        this.store.marcarEventoMeta(e.id, false, String(err));
      }
    }
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

  /** 14 días sin respuesta: Intake -> Not qualified. 21 días: Qualified -> Lost. Solo cambian la etapa. */
  private reglasDePaso(ahora: Date): void {
    const marca = partesLocales(ahora, this.cfg.TZ_NEGOCIO);
    const clave = `reglas_paso_${marca.fecha}_${marca.hora}`;
    if (this.store.kv("reglas_paso") === clave) return; // una vez por hora basta
    this.store.setKv("reglas_paso", clave);
    for (const l of this.store.todos()) {
      if (l.dueno === "VERO" || l.pausado) continue;
      const dias = diasDesde(l.ultimo_in ?? l.creado, ahora);
      const salientes = this.nuestros(l.telefono).length;
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

  private material(lead: Lead) {
    return {
      presentacion: this.presentacion(lead),
      videoUrl: this.cfg.VIDEO_EDUCATIVO_URL,
      testimoniosUrl: this.cfg.TESTIMONIOS_URL,
      telefonoDaniela: this.cfg.TELEFONO_DANIELA,
    };
  }

  private async turno(tel: string, modo: Modo, opciones?: { destino?: "chrome"; cuando?: "hoy" | "mañana" }): Promise<void> {
    const lead = this.store.lead(tel);
    if (!lead || lead.pausado || lead.dueno === "VERO") {
      if (lead) this.store.actualizar(tel, { pendiente_desde: null });
      return;
    }
    const ahora = this.reloj();
    let mensajes = this.store.mensajes(tel);
    // En sombra, el agente ve la conversación hasta el último mensaje del lead (no lo que ya respondieron las rondas).
    if (this.sombra && modo === "respuesta") {
      const ultimoIn = mensajes.map((m) => m.direccion).lastIndexOf("in");
      if (ultimoIn >= 0) mensajes = mensajes.slice(0, ultimoIn + 1);
    }
    const h = hechos(lead, mensajes, this.cfg.VIDEO_EDUCATIVO_URL);
    const texto = armarContexto(lead, mensajes, { modo, ahora, tz: this.cfg.TZ_NEGOCIO, material: this.material(lead), cuando: opciones?.cuando });

    // Adjuntos del lead desde nuestro último mensaje (comprobantes): el agente los ve.
    const adjuntos: { mediaType: string; base64: string }[] = [];
    for (const m of [...mensajes].reverse()) {
      if (m.direccion !== "in") break;
      if (!m.media_path) continue;
      const [mime, ruta] = m.media_path.split("|");
      if (MEDIA_VISIBLE.test(mime) && fs.existsSync(ruta) && adjuntos.length < 3) {
        adjuntos.push({ mediaType: mime, base64: fs.readFileSync(ruta).toString("base64") });
      }
    }

    const respondeA = modo === "respuesta" ? (lead.pendiente_desde ?? null) : null;
    // Foto del chat antes de decidir: si mientras tanto el lead escribe o Mario contesta, la decisión ya no vale.
    const ultimoIdAntes = this.ultimoIdMensaje(tel);
    // Un seguimiento cuenta como toque aunque el agente decida no enviar nada (si no, se reintentaría en cada ciclo).
    if (modo === "seguimiento") this.avanzarToque(tel, ahora);
    const d = await this.agente.decidir({
      texto,
      adjuntos,
      estado: { chatNuevo: h.chatNuevo, preguntasProfundizar: lead.preguntas_profundizar, precioEvaluacionDado: h.precioEvaluacionDado },
      validarCita: (fechaHora) => this.validarCita(tel, fechaHora),
    });
    this.store.log(tel, "decision", JSON.stringify(d));

    const nuevos = this.store.mensajesDespuesDe(tel, ultimoIdAntes);
    if (nuevos.some((m) => m.direccion === "in")) {
      // El lead escribió mientras el agente decidía: se descarta y se vuelve a leer todo en un minuto.
      this.store.log(tel, "decision_descartada", "el lead escribió durante la decisión");
      this.store.actualizar(tel, { pendiente_desde: this.store.lead(tel)!.pendiente_desde ?? ahora.toISOString(), responder_despues: new Date(this.reloj().getTime() + 60_000).toISOString() });
      return;
    }
    if (!this.sombra && nuevos.some((m) => m.direccion === "eco" || m.direccion === "out")) {
      // Mario (u otro proceso) contestó mientras el agente decidía: no se duplica.
      this.store.log(tel, "decision_descartada", "alguien del equipo contestó durante la decisión");
      return;
    }
    this.store.actualizar(tel, { pendiente_desde: null, responder_despues: null });
    if (this.sombra) {
      this.store.guardarSombra({
        telefono: tel,
        modo: opciones?.destino === "chrome" ? "seguimiento (para Chrome)" : modo,
        ts_lead: respondeA,
        ts_propuesta: ahora.toISOString(),
        decision: JSON.stringify(d),
        contexto_hasta: mensajes.at(-1)?.ts ?? null,
      });
      // Solo datos inofensivos: el estado real del lead lo siguen llevando las rondas y Mario.
      for (const x of d.datos) {
        if (x.campo === "nombre" && !lead.nombre) this.store.actualizar(tel, { nombre: x.valor });
      }
      return;
    }
    if (opciones?.destino === "chrome") return this.dejarParaChrome(lead, d, ahora);
    await this.aplicar(lead, d, modo, respondeA);
  }

  private ultimoIdMensaje(tel: string): number {
    const r = this.store.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM mensajes WHERE telefono = ?").get(tel) as { id: number };
    return r.id;
  }

  /** Suma un toque y agenda el siguiente (se llama antes de decidir, así nunca queda en un bucle). */
  private avanzarToque(tel: string, ahora: Date): void {
    const l = this.store.lead(tel)!;
    const intentos = l.intentos_sin_respuesta + 1;
    this.store.actualizar(tel, {
      intentos_sin_respuesta: intentos,
      proximo_toque: this.calcularProximoToque({ ...l, intentos_sin_respuesta: intentos }, ahora),
    });
  }

  /** Reglas de una cita de evaluación: futura, entre semana, sin feriados, dentro del horario y sin choque con otra cita. */
  validarCita(tel: string, fechaHora: string): string | null {
    const inicio = desdeLocal(fechaHora);
    const fin = new Date(inicio.getTime() + this.cfg.DURACION_EVALUACION_MIN * 60_000);
    const ahora = this.reloj();
    if (inicio.getTime() < ahora.getTime() + 60 * 60_000) return "Esa hora ya pasó o es demasiado pronto: ofrece otra.";
    const fecha = fechaHora.slice(0, 10);
    const ref = new Date(`${fecha}T12:00:00-05:00`);
    const dia = partesLocales(ref, this.cfg.TZ_NEGOCIO).diaSemana;
    if (dia === "Sat" || dia === "Sun") return "Es fin de semana: la evaluación es solo entre semana.";
    if (this.cfg.feriados.has(fecha)) return "Es feriado: no se atiende. Ofrece otro día.";
    const [a, b] = this.cfg.horarioEvaluaciones;
    const minIni = Number(fechaHora.slice(11, 13)) * 60 + Number(fechaHora.slice(14, 16));
    if (minIni < a || minIni + this.cfg.DURACION_EVALUACION_MIN > b) {
      return `Fuera del horario de evaluaciones (la sesión de ${this.cfg.DURACION_EVALUACION_MIN} min debe empezar después de las ${String(a / 60 | 0).padStart(2, "0")}:${String(a % 60).padStart(2, "0")} y terminar antes de las ${String(b / 60 | 0).padStart(2, "0")}:${String(b % 60).padStart(2, "0")}).`;
    }
    const choque = this.store
      .leadsConCita()
      .find((l) => l.telefono !== tel && l.etapa !== "Lost" && new Date(l.cita!) < fin && new Date(new Date(l.cita!).getTime() + this.cfg.DURACION_EVALUACION_MIN * 60_000) > inicio);
    if (choque) return "Esa hora ya está reservada para otra persona (pendiente de pago). Ofrece otra hora libre.";
    return null;
  }

  /** Seguimiento fuera de la ventana de 24 h: el agente lo redacta y lo envían las rondas de Chrome. */
  private async dejarParaChrome(lead: Lead, d: Decision, ahora: Date): Promise<void> {
    const tel = lead.telefono;
    if (d.escalacion) {
      await this.escalar(lead, { categoria: d.escalacion.categoria, motivo: d.escalacion.motivo, propuesta: d.escalacion.propuesta || null });
      return;
    }
    this.aplicarDatos(tel, d);
    const texto = d.mensajes.map((m) => m.texto).join("\n\n");
    const l = this.store.lead(tel)!;
    if (texto) {
      const motivo = `${l.paso}, ${diasDesde(l.ultimo_in ?? l.creado, ahora)} días sin respuesta`;
      this.store.agregarParaChrome(tel, partesLocales(ahora, this.cfg.TZ_NEGOCIO).fecha, texto, motivo);
    }
    if (l.paso === "nuevo") this.store.actualizar(tel, { paso: "contactado" });
  }

  /** Datos, etapa y paso que decidió el agente. */
  private aplicarDatos(tel: string, d: Decision): void {
    for (const x of d.datos) {
      const l = this.store.lead(tel)!;
      if (x.campo === "nombre") this.store.actualizar(tel, { nombre: x.valor });
      else if (x.campo === "ciudad") this.store.actualizar(tel, { ciudad: x.valor });
      else if (x.campo === "nota") this.store.actualizar(tel, { notas: [l.notas, x.valor].filter(Boolean).join(" | ") });
      else if (x.campo === "aprendizaje") this.store.log(tel, "aprendizaje", x.valor);
      else if (x.campo === "no_explicito") this.store.actualizar(tel, { dijo_no: 1, proximo_toque: null });
      else if (x.campo === "fecha_acordada") this.store.actualizar(tel, { fecha_acordada: x.valor });
      else if (x.campo === "oferta_dani") {
        const v = { ofrecida: 1, aceptada: 2, rechazada: 3 }[x.valor as "ofrecida"] ?? 1;
        this.store.actualizar(tel, { oferta_dani: v, ...(v === 3 ? { dijo_no: 1, proximo_toque: null } : {}) });
      }
    }
    const actual = this.store.lead(tel)!;
    const etapa = etapaFinal(actual.etapa, d.etapa);
    if (etapa !== actual.etapa) this.store.actualizar(tel, { etapa });
    if (d.paso) this.store.actualizar(tel, { paso: d.paso });
  }

  private async aplicar(lead: Lead, d: Decision, modo: Modo, respondeA: string | null): Promise<void> {
    const tel = lead.telefono;
    this.aplicarDatos(tel, d);

    if (d.rechazo) {
      await this.escalar(this.store.lead(tel)!, { categoria: "otro", motivo: "El modelo no pudo generar una respuesta para este chat. Revísalo tú.", propuesta: null });
      return;
    }

    if (d.escalacion) {
      await this.escalar(this.store.lead(tel)!, {
        categoria: d.escalacion.categoria,
        motivo: d.escalacion.motivo,
        propuesta: d.escalacion.propuesta || null,
        pausar: !d.escalacion.enviarTambien,
      });
      if (!d.escalacion.enviarTambien) return; // queda sin responder y sin leer, como pidió Mario
    }

    const hayAccion = d.mensajes.length > 0 || !!d.datosPago || !!d.comprobante;
    if (d.noResponder && !hayAccion) {
      this.marcarLeidoUltimo(tel);
      return;
    }
    if (!hayAccion && !d.escalacion) {
      // El agente no decidió nada: el lead no puede quedar sin respuesta y sin que nadie lo sepa.
      if (modo === "respuesta") {
        await this.escalar(this.store.lead(tel)!, { categoria: "otro", motivo: "El agente no logró decidir una respuesta para este chat. Revísalo tú.", propuesta: null });
      }
      return;
    }

    // Modo aprobación: todo pasa por Mario, incluidas la cuenta y el registro del comprobante.
    if (this.cfg.MODO === "aprobacion" && hayAccion) {
      const extra = [d.datosPago ? `[enviar cuenta y formulario: ${d.datosPago.fechaHora}, ${d.datosPago.modalidad}]` : "", d.comprobante ? `[registrar comprobante: ${d.comprobante}]` : ""].filter(Boolean);
      const propuesta = [...d.mensajes.map((m) => m.texto), ...extra].join(SEPARADOR);
      await this.escalar(this.store.lead(tel)!, {
        categoria: "aprobacion",
        motivo: "Respuesta para aprobar",
        propuesta,
        accion: JSON.stringify({ mensajes: d.mensajes, datosPago: d.datosPago, comprobante: d.comprobante, respondeA }),
      });
      return;
    }

    await this.ejecutar(tel, d, modo, respondeA);
  }

  /** Envía lo decidido (mensajes, cuenta para el pago, registro del comprobante) y agenda el próximo toque. */
  private async ejecutar(
    tel: string,
    d: Pick<Decision, "mensajes" | "datosPago" | "comprobante">,
    modo: Modo,
    respondeA: string | null,
    autor = "agente",
  ): Promise<void> {
    const ahora = this.reloj();
    let enviados = 0;
    for (const m of d.mensajes) {
      if (enviados > 0) await this.dormir(15_000 + this.azar() * 30_000); // pausa entre dos mensajes seguidos
      await this.enviarTexto(this.store.lead(tel)!, m.texto, { autor, tipo: m.tipo, respondeA, humano: true });
      const l = this.store.lead(tel)!;
      const cambios: Partial<Lead> = {};
      if (m.profundizar) cambios.preguntas_profundizar = l.preguntas_profundizar + 1;
      if (m.reflejo) cambios.reflejo_enviado = 1;
      if (/\$\s?40\b/.test(m.texto)) cambios.precio_evaluacion_dado = 1;
      if (/\$\s?490/.test(m.texto)) cambios.precio_programa_dado = 1;
      if (/conoces la terapia asistida/i.test(m.texto)) cambios.pregunto_conoce_terapia = 1;
      if (this.cfg.VIDEO_EDUCATIVO_URL && m.texto.includes(this.cfg.VIDEO_EDUCATIVO_URL)) cambios.video_enviado = 1;
      if (/hasta las 19:00/.test(m.texto)) cambios.horario_ofrecido = 1;
      this.store.actualizar(tel, cambios);
      enviados++;
    }

    if (d.datosPago) enviados += await this.enviarDatosPago(tel, d.datosPago);
    if (d.comprobante) {
      await this.registrarComprobante(tel, d.comprobante);
      return;
    }
    if (!enviados) return;

    const l = this.store.lead(tel)!;
    const cambios: Partial<Lead> = {};
    if (l.paso === "nuevo") cambios.paso = "contactado";
    if (modo === "respuesta") {
      cambios.intentos_sin_respuesta = 0;
      cambios.proximo_toque = this.calcularProximoToque({ ...l, ...cambios } as Lead, ahora);
    }
    this.store.actualizar(tel, cambios);
    this.marcarLeidoUltimo(tel);
  }

  private calcularProximoToque(l: Lead, ahora: Date): string | null {
    if (l.dijo_no || SIN_SEGUIMIENTO.has(l.etapa) || l.paso === "agendado" || l.paso === "cerrado") return null;
    return proximoToque(ahora, diasDesde(l.ultimo_in ?? l.creado, ahora), l.intentos_sin_respuesta, {
      tz: this.cfg.TZ_NEGOCIO,
      feriados: this.cfg.feriados,
      franjas: this.cfg.franjasSeguimiento,
      azar: this.azar,
      fechaAcordada: l.fecha_acordada,
    }).toISOString();
  }

  /** Cuenta para la transferencia de $40 y formulario, con el texto aprobado (manual, sección 4). */
  private async enviarDatosPago(tel: string, p: { fechaHora: string; modalidad: string }): Promise<number> {
    const cita = desdeLocal(p.fechaHora).toISOString();
    this.store.actualizar(tel, { cita, modalidad: p.modalidad, paso: "comprometido" });
    const lead = this.store.lead(tel)!;
    if (lead.etapa === "Intake" || lead.etapa === "Not qualified" || lead.etapa === "Lost") this.store.actualizar(tel, { etapa: "Qualified" });
    if (!this.cfg.DATOS_TRANSFERENCIA) {
      await this.escalar(lead, {
        categoria: "pago",
        motivo: `Eligió ${formatoCita(cita, this.cfg.TZ_NEGOCIO)} (${p.modalidad}). Falta configurar DATOS_TRANSFERENCIA: envía tú la cuenta.`,
        propuesta: null,
      });
      return 0;
    }
    const cuenta = this.cfg.DATOS_TRANSFERENCIA.split("|").map((x) => x.trim()).filter(Boolean).join("\n");
    await this.enviarTexto(
      lead,
      `Excelente. La transferencia de los $40 por favor a esta cuenta:\n${cuenta}\n\nCuando la hagas, me envías el comprobante y yo te agendo la evaluación en ese día y hora.`,
      { autor: "sistema", tipo: "otro", humano: true },
    );
    await this.enviarTexto(
      this.store.lead(tel)!,
      `Y este es el formulario que se llena antes de la sesión de evaluación: ${this.cfg.FORMULARIO_EVALUACION_URL}`,
      { autor: "sistema", tipo: "otro", humano: true },
    );
    this.store.actualizar(tel, { datos_pago_enviados: 1, horario_ofrecido: 1 });
    return 2;
  }

  /** Con el comprobante: evento en el calendario principal, confirmación, formulario y dirección si es presencial. */
  /**
   * Con el comprobante: evento en el calendario principal (Meet si es en línea), confirmación, formulario,
   * dirección si es presencial y aviso a Mario. porMario = lo confirmó Mario (OK de "agendar" o PAGADO).
   */
  private async registrarComprobante(tel: string, evidencia: string, o: { porMario?: boolean; sinEvento?: boolean } = {}): Promise<string> {
    const lead = this.store.lead(tel)!;
    if (!lead.cita) {
      await this.escalar(lead, { categoria: "otro", motivo: `Envió un comprobante (${evidencia}) pero no hay día y hora acordados en el sistema.`, propuesta: null });
      return "sin cita";
    }
    const nombre = (lead.nombre ?? "").split(" ")[0];
    const cuando = formatoCita(lead.cita, this.cfg.TZ_NEGOCIO);
    const modalidad = lead.modalidad === "presencial" ? "presencial en Cumbayá" : "en línea";
    const enLinea = lead.modalidad !== "presencial";
    const confirmacion = `${nombre ? `${nombre}, q` : "Q"}uedó agendada tu evaluación para el ${cuando}, ${modalidad}. Te escribo un día antes para recordártelo.`;
    const pasarAMario = async (motivo: string) => {
      await this.escalar(lead, {
        categoria: "agendar",
        motivo: `Comprobante recibido (${evidencia}) para ${cuando}, ${modalidad}. ${motivo}`,
        propuesta: confirmacion,
        accion: JSON.stringify({ marcarPagado: true }),
      });
      return "a Mario";
    };

    let ev: { link: string; meet: string | null } | null = null;
    if (this.calendario && !o.sinEvento) {
      try {
        if (!o.porMario && this.calendario.libre && !(await this.calendario.libre(lead.cita, this.cfg.DURACION_EVALUACION_MIN))) {
          return pasarAMario("Esa hora ya no está libre en tu calendario: elige otra con el lead y usa PAGADO.");
        }
        ev = await this.calendario.crearEvaluacion(
          lead.cita,
          `Sesión de evaluación con ${lead.nombre ?? `+${tel}`}`,
          `Nombre: ${lead.nombre ?? "-"}\nTeléfono: +${tel}\nModalidad: ${modalidad}\nComprobante: ${evidencia}`,
          this.cfg.DURACION_EVALUACION_MIN,
          enLinea,
        );
      } catch (e) {
        return pasarAMario(`No se pudo crear el evento (${String(e).slice(0, 120)}): créalo tú y aprueba la confirmación.`);
      }
    } else if (!o.porMario) {
      return pasarAMario(`Calendario no conectado: crea tú el evento "Sesión de evaluación con ${lead.nombre ?? tel}" y aprueba la confirmación.`);
    }

    // El pago queda registrado apenas existe el evento: así un segundo comprobante no duplica nada.
    this.store.actualizar(tel, { pago_confirmado: 1, etapa: "Agendo sesion Evaluacion", paso: "agendado", proximo_toque: null });
    this.store.log(tel, "evaluacion_agendada", `${lead.cita} ${modalidad}`);
    await this.enviarTexto(this.store.lead(tel)!, confirmacion, { autor: "sistema", tipo: "evaluación", humano: true });
    if (enLinea && ev?.meet) {
      await this.enviarTexto(this.store.lead(tel)!, `Este es el link para conectarte ese día: ${ev.meet}`, { autor: "sistema", tipo: "otro", humano: true });
    }
    await this.enviarTexto(
      this.store.lead(tel)!,
      `Antes de la sesión necesito que llenes este formulario, siempre se llena antes de la evaluación: ${this.cfg.FORMULARIO_EVALUACION_URL}`,
      { autor: "sistema", tipo: "otro", humano: true },
    );
    if (!enLinea && this.cfg.DIRECCION_CUMBAYA) {
      await this.enviarTexto(
        this.store.lead(tel)!,
        `La dirección es ${this.cfg.DIRECCION_CUMBAYA}.${this.cfg.MAPS_URL ? ` Aquí la ubicación: ${this.cfg.MAPS_URL}` : ""}`,
        { autor: "sistema", tipo: "otro", humano: true },
      );
    }
    if (!o.porMario) {
      await this.notificar(`Evaluación agendada: +${tel}${lead.nombre ? ` (${lead.nombre})` : ""}, ${cuando}, ${modalidad}.${ev?.meet ? ` Meet: ${ev.meet}` : ""}${ev ? ` Evento: ${ev.link}` : ""}`);
    }
    this.marcarLeidoUltimo(tel);
    return ev ? `agendada${ev.meet ? `, Meet: ${ev.meet}` : ""}` : o.sinEvento ? "confirmada al lead y pago registrado" : "confirmada al lead (sin calendario: crea tú el evento)";
  }

  /** Día anterior a la cita: recordar y confirmar asistencia (y el pago si falta). Mismo día si no pagó. */
  private async recordatoriosDeCita(ahora: Date): Promise<void> {
    if (this.sombra) return; // las citas reales las recuerda aún el sistema anterior
    const hoy = partesLocales(ahora, this.cfg.TZ_NEGOCIO).fecha;
    const manana = partesLocales(new Date(ahora.getTime() + DIA), this.cfg.TZ_NEGOCIO).fecha;
    for (const l of this.store.leadsConCita()) {
      if (l.pausado || l.dueno === "VERO" || l.etapa === "Converted" || l.etapa === "Lost") continue;
      if (this.ocupados.has(l.telefono)) continue; // se intenta en el siguiente ciclo
      const diaCita = partesLocales(new Date(l.cita!), this.cfg.TZ_NEGOCIO).fecha;
      if (new Date(l.cita!) <= ahora) continue;
      const toca = diaCita === manana || (diaCita === hoy && !l.pago_confirmado);
      if (!toca || l.recordatorio_cita === hoy) continue;
      // Si la cita se acordó hace pocas horas (acaba de recibir la cuenta), no hace falta recordar todavía.
      if (diaCita === manana && l.datos_pago_enviados && l.ultimo_out && ahora.getTime() - new Date(l.ultimo_out).getTime() < 6 * 3600_000) {
        this.store.actualizar(l.telefono, { recordatorio_cita: hoy });
        continue;
      }
      const cuando = diaCita === hoy ? "hoy" : "mañana";
      await this.conCandado(l.telefono, async () => {
        if (ventanaAbierta(l.ultimo_in, ahora)) await this.turno(l.telefono, "recordatorio", { cuando });
        else {
          const nombre = (l.nombre ?? "").split(" ")[0] || "hola";
          const hora = new Date(l.cita!).toLocaleTimeString("es-EC", { timeZone: this.cfg.TZ_NEGOCIO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
          await this.enviarPlantilla(l, this.cfg.PLANTILLA_RECORDATORIO_EVALUACION, [nombre, cuando, hora]);
        }
        this.store.actualizar(l.telefono, { recordatorio_cita: hoy }); // solo si salió sin error
      });
    }
  }

  /** Toque de seguimiento (o primer contacto de un lead de formulario). */
  private async seguimiento(tel: string): Promise<void> {
    const lead = this.store.lead(tel);
    if (!lead) return;
    const ahora = this.reloj();
    if (lead.pausado || lead.dueno === "VERO" || lead.dijo_no || SIN_SEGUIMIENTO.has(lead.etapa) || lead.paso === "agendado") {
      this.store.actualizar(tel, { proximo_toque: null });
      return;
    }
    if (lead.humano_hasta && new Date(lead.humano_hasta) > ahora) {
      this.store.actualizar(tel, { proximo_toque: lead.humano_hasta });
      return;
    }
    if (lead.fecha_acordada && new Date(`${lead.fecha_acordada}T00:00:00-05:00`) > ahora) {
      this.store.actualizar(tel, { proximo_toque: this.calcularProximoToque(lead, ahora) });
      return;
    }
    // Los seguimientos solo salen de lunes a viernes dentro de las franjas (si llegó tarde, se reprograma).
    // El primer contacto de un lead de formulario es como una respuesta: puede salir a cualquier hora.
    const franjas = { tz: this.cfg.TZ_NEGOCIO, feriados: this.cfg.feriados, franjas: this.cfg.franjasSeguimiento };
    if (lead.paso !== "nuevo" && !enFranjaSeguimiento(ahora, franjas)) {
      let t = new Date(ahora.getTime() + 15 * 60_000);
      for (let i = 0; i < 7 * 24 * 4 && !enFranjaSeguimiento(t, franjas); i++) t = new Date(t.getTime() + 15 * 60_000);
      this.store.actualizar(tel, { proximo_toque: new Date(t.getTime() + Math.floor(this.azar() * 40) * 60_000).toISOString() });
      return;
    }

    // Dentro de las 24 h desde su último mensaje: el agente redacta un toque a medida.
    if (ventanaAbierta(lead.ultimo_in, ahora)) return this.turno(tel, "seguimiento");

    // Fuera de la ventana: el agente lo redacta y lo envían las rondas de Chrome (la app no tiene la regla de plantillas)...
    if (this.cfg.SEGUIMIENTO_FUERA_DE_VENTANA === "chrome") return this.turno(tel, "seguimiento", { destino: "chrome" });

    // ...o, si se eligió así, solo plantillas aprobadas por Meta.
    const nombre = (lead.nombre ?? "").split(" ")[0] || "hola";
    const silencio = diasDesde(lead.ultimo_in ?? lead.creado, ahora);
    const yaEnviada = (p: string) => this.store.mensajes(tel, 500).some((m) => m.texto.startsWith(`[plantilla ${p}]`));
    let plantilla: string;
    let params: string[];
    if (lead.paso === "nuevo") {
      const pres = this.presentacion(lead);
      if (!pres) {
        this.store.actualizar(tel, { pausado: 1, motivo_pausa: "presentación de Dani pendiente", proximo_toque: null });
        await this.escalar(this.store.lead(tel)!, { categoria: "otro", motivo: "Primer contacto en chat de Dani: falta definir cómo presentarse (PRESENTACION_DANI).", propuesta: null });
        return;
      }
      if (lead.historial_incompleto || this.nuestros(tel).length) {
        // Nunca la plantilla de primer mensaje en un chat con conversación (Mario, 22 nov 2026 14:29).
        this.store.actualizar(tel, { paso: "contactado", proximo_toque: null });
        await this.escalar(this.store.lead(tel)!, { categoria: "historial", motivo: "Lead de formulario que ya tenía conversación en el chat. No se envió la plantilla de primer mensaje.", propuesta: null });
        return;
      }
      if (lead.origen === "abandonado") {
        plantilla = this.cfg.PLANTILLA_ABANDONADO;
        params = [nombre, pres];
      } else if (lead.formulario) {
        plantilla = this.cfg.PLANTILLA_PRIMER_CONTACTO;
        params = [nombre, pres, resumir(lead.formulario, 120)];
      } else {
        plantilla = this.cfg.PLANTILLA_PRIMER_CONTACTO_SIN_RESPUESTA;
        params = [nombre, pres];
      }
    } else if (lead.paso === "contactado" && silencio >= 10 && !yaEnviada(this.cfg.PLANTILLA_RECONEXION_3)) {
      plantilla = this.cfg.PLANTILLA_RECONEXION_3;
      params = [nombre];
    } else if (["abrio", "conectado", "educado"].includes(lead.paso) && silencio >= 12 && !yaEnviada(this.cfg.PLANTILLA_RECONEXION_2)) {
      plantilla = this.cfg.PLANTILLA_RECONEXION_2;
      params = [nombre];
    } else if (["ofrecido", "comprometido"].includes(lead.paso) && silencio >= 18 && !yaEnviada(this.cfg.PLANTILLA_RECONEXION_1)) {
      plantilla = this.cfg.PLANTILLA_RECONEXION_1;
      params = [nombre];
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

    await this.enviarPlantilla(lead, plantilla, params);
    const primerContacto = lead.paso === "nuevo";
    const intentos = primerContacto ? 0 : lead.intentos_sin_respuesta + 1;
    const l = { ...this.store.lead(tel)!, paso: primerContacto ? ("contactado" as const) : lead.paso, intentos_sin_respuesta: intentos };
    this.store.actualizar(tel, { paso: l.paso, intentos_sin_respuesta: intentos, proximo_toque: this.calcularProximoToque(l, ahora) });
  }

  // =====================================================================
  // Envío, escalación y notificaciones
  // =====================================================================

  /**
   * Envía un texto. Con humano=true, antes muestra "escribiendo..." el tiempo que tomaría escribirlo
   * (y marca como leído el último mensaje del lead), como lo haría una persona.
   */
  private async enviarTexto(
    lead: Lead,
    texto: string,
    o: { autor: string; tipo?: string; respondeA?: string | null; humano?: boolean },
  ): Promise<void> {
    if (this.sombra && !this.cfg.adminNumeros.includes(lead.telefono)) {
      this.store.log(lead.telefono, "sombra_bloqueado", texto); // en sombra nada sale hacia un lead
      return;
    }
    if (o.humano) {
      const ultimoIn = [...this.store.mensajes(lead.telefono, 10)].reverse().find((m) => m.direccion === "in" && m.wa_id);
      if (ultimoIn?.wa_id && this.wa.escribiendo) await this.wa.escribiendo(ultimoIn.wa_id).catch(() => {});
      await this.dormir(tiempoEscritura(texto, this.azar));
    }
    const waId = await this.wa.enviarTexto(lead.telefono, texto);
    const ts = this.reloj().toISOString();
    this.store.guardarMensaje({
      telefono: lead.telefono,
      direccion: "out",
      tipo: "text",
      texto,
      wa_id: waId || null,
      autor: o.autor,
      ts,
      tipo_envio: o.tipo ?? null,
      responde_a: o.respondeA ?? null,
    });
    this.store.actualizar(lead.telefono, { ultimo_out: ts });
  }

  private async enviarPlantilla(lead: Lead, plantilla: string, params: string[]): Promise<void> {
    if (this.sombra) {
      this.store.guardarSombra({
        telefono: lead.telefono,
        modo: "plantilla",
        ts_lead: null,
        ts_propuesta: this.reloj().toISOString(),
        decision: JSON.stringify({ accion: `Plantilla ${plantilla}`, mensajes: [{ texto: params.join(" | ") }] }),
        contexto_hasta: null,
      });
      return;
    }
    const waId = await this.wa.enviarPlantilla(lead.telefono, plantilla, params);
    const ts = this.reloj().toISOString();
    this.store.guardarMensaje({
      telefono: lead.telefono,
      direccion: "out",
      tipo: "template",
      texto: `[plantilla ${plantilla}] ${params.join(" | ")}`,
      wa_id: waId || null,
      autor: "plantilla",
      ts,
      tipo_envio: plantilla.startsWith("primer") ? "primer mensaje" : plantilla.startsWith("reconexion") ? "reconexión" : "otro",
    });
    this.store.actualizar(lead.telefono, { ultimo_out: ts });
  }

  private marcarLeidoUltimo(tel: string): void {
    if (this.sombra) return; // marcar como leído cambiaría lo que ve Mario en la app
    const ultimo = [...this.store.mensajes(tel, 10)].reverse().find((m) => m.direccion === "in" && m.wa_id);
    if (ultimo?.wa_id) this.wa.marcarLeido(ultimo.wa_id).catch(() => {});
  }

  private async escalar(
    lead: Lead,
    e: { categoria: string; motivo: string; propuesta: string | null; pausar?: boolean; accion?: string },
  ): Promise<Escalacion> {
    const esc = this.store.crearEscalacion({ telefono: lead.telefono, categoria: e.categoria, motivo: e.motivo, propuesta: e.propuesta, accion: e.accion ?? null });
    if (e.pausar !== false) {
      this.store.actualizar(lead.telefono, {
        pausado: 1,
        motivo_pausa: lead.motivo_pausa ?? `escalación #${esc.id} (${e.categoria})`,
        pendiente_desde: null,
      });
    }
    // Política de avisos (Mario, 22 nov 2026): un solo reporte al día; aviso inmediato solo en casos graves.
    const inmediato = this.cfg.avisosInmediatos.has(e.categoria) || this.cfg.MODO === "aprobacion";
    if (inmediato) {
      await this.notificar(textoEscalacion(esc, lead, true));
      this.store.marcarAvisada(esc.id);
    }
    return esc;
  }

  async notificar(texto: string): Promise<void> {
    for (const admin of this.cfg.notificarA) {
      try {
        const abierta = ventanaAbierta(this.ultimoInAdmin.get(admin) ?? null, this.reloj());
        if (abierta) await this.wa.enviarTexto(admin, texto);
        else await this.wa.enviarPlantilla(admin, this.cfg.PLANTILLA_ALERTA, [paraPlantilla(texto)]);
      } catch {
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
  // Reporte diario (07:50): casos para Mario, números de ayer, espera, citas
  // =====================================================================

  private async quizasReporteDiario(ahora: Date): Promise<void> {
    const [hh, mm] = this.cfg.HORA_REPORTE_DIARIO.split(":").map(Number);
    const p = partesLocales(ahora, this.cfg.TZ_NEGOCIO);
    if (p.hora * 60 + p.minuto < hh * 60 + mm) return;
    if (this.store.kv("reporte_diario") === p.fecha) return;
    this.store.setKv("reporte_diario", p.fecha);
    await this.notificar(this.reporteDiario(ahora));
  }

  /** Lado a lado: lo que habría hecho el agente y lo que se envió de verdad (rondas de Chrome, Mario). */
  comparacionSombra(desde: Date, hasta: Date): FilaComparacion[] {
    const filas: FilaComparacion[] = [];
    for (const s of this.store.sombraEntre(desde, hasta)) {
      const d = JSON.parse(s.decision);
      const lead = this.store.lead(s.telefono);
      const msgs = this.store.mensajes(s.telefono, 500);
      const corte = s.contexto_hasta ?? s.ts_propuesta;
      // Mensajes del lead de esta ráfaga: los "in" seguidos hasta el corte.
      const previos = msgs.filter((m) => m.ts <= corte);
      const delLead: string[] = [];
      for (let i = previos.length - 1; i >= 0 && previos[i].direccion === "in"; i--) delLead.unshift(previos[i].texto || `[${previos[i].tipo}]`);
      // Respuesta real: lo nuestro (rondas o Mario) después del corte y antes del siguiente mensaje del lead.
      const real: { quien: string; texto: string }[] = [];
      let primerReal: string | null = null;
      for (const m of msgs.filter((x) => x.ts > corte)) {
        if (m.direccion === "in") break;
        if (m.direccion === "eco" || m.direccion === "out") {
          real.push({ quien: m.direccion === "eco" ? "app (rondas o Mario)" : m.autor ?? "sistema", texto: m.texto });
          primerReal ??= m.ts;
        }
      }
      const accion = d.accion
        ?? (d.escalacion ? `Escala a Mario (${d.escalacion.categoria}): ${d.escalacion.motivo}${d.escalacion.propuesta ? ` | Propuesta: ${d.escalacion.propuesta}` : ""}` : null)
        ?? (d.datosPago ? `Envía cuenta y formulario para ${d.datosPago.fechaHora} (${d.datosPago.modalidad})` : null)
        ?? (d.comprobante ? `Registra comprobante y agenda (${d.comprobante})` : null)
        ?? (d.noResponder ? `No responde: ${d.noResponder}` : null)
        ?? (d.rechazo ? "El modelo no generó respuesta" : null);
      const base = s.ts_lead ?? s.ts_propuesta;
      filas.push({
        telefono: s.telefono,
        nombre: lead?.nombre ?? null,
        modo: s.modo,
        lead: delLead,
        propuesta: (d.mensajes ?? []).map((m: { texto: string }) => m.texto),
        accion,
        etapa: d.etapa ?? null,
        real,
        minutosReal: primerReal ? Math.round((new Date(primerReal).getTime() - new Date(base).getTime()) / 60_000) : null,
        minutosAgente: s.ts_lead ? Math.round((this.cfg.LECTURA_MIN_MINUTOS + this.cfg.LECTURA_MAX_MINUTOS) / 2) : null,
      });
    }
    return filas;
  }

  reporteDiario(ahora: Date): string {
    if (this.sombra) return this.reporteSombra(ahora);
    const tz = this.cfg.TZ_NEGOCIO;
    const p = partesLocales(ahora, tz);
    const inicioHoy = new Date(`${p.fecha}T00:00:00-05:00`);
    const inicioAyer = new Date(inicioHoy.getTime() - DIA);
    const msgs = this.store.mensajesEntre(inicioAyer, inicioHoy);
    const enviados = msgs.filter((m) => m.direccion === "out");
    const respuestas = msgs.filter((m) => m.direccion === "in");
    const nuevos = this.store.todos().filter((l) => l.creado >= inicioAyer.toISOString() && l.creado < inicioHoy.toISOString()).length;
    const agendadas = this.store.db
      .prepare("SELECT COUNT(*) AS n FROM bitacora WHERE evento = 'evaluacion_agendada' AND ts >= ? AND ts < ?")
      .get(inicioAyer.toISOString(), inicioHoy.toISOString()) as { n: number };
    const esperas = enviados
      .filter((m) => m.responde_a)
      .map((m) => ({ tel: m.telefono, min: Math.round((new Date(m.ts).getTime() - new Date(m.responde_a!).getTime()) / 60_000) }));
    const unicas = [...new Map(esperas.map((e) => [`${e.tel}`, e])).values()];
    unicas.sort((a, b) => a.min - b.min);
    const mediana = unicas.length ? unicas[Math.floor(unicas.length / 2)].min : null;
    const peor = unicas.at(-1);
    const mas15 = unicas.filter((e) => e.min > 15).length;

    const pendientes = this.store.escalacionesPendientes();
    const dia = ahora.toLocaleDateString("es-EC", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
    const lineas: string[] = [];
    lineas.push(`Reporte diario, ${dia}: ${pendientes.length ? `tienes ${pendientes.length} caso${pendientes.length > 1 ? "s" : ""} por atender.` : "todo en orden, no tienes que hacer nada hoy."}`);
    if (pendientes.length) {
      lineas.push("", "Te toca a ti hoy:");
      for (const e of pendientes.slice(0, 8)) {
        const l = this.store.lead(e.telefono);
        lineas.push(textoEscalacion(e, l ?? null, false));
        this.store.marcarAvisada(e.id);
      }
      if (pendientes.length > 8) lineas.push(`Y ${pendientes.length - 8} más: escribe PENDIENTES.`);
    }
    const citas = this.store
      .leadsConCita()
      .filter((l) => {
        const f = partesLocales(new Date(l.cita!), tz).fecha;
        return f === p.fecha || f === partesLocales(new Date(ahora.getTime() + DIA), tz).fecha;
      })
      .map((l) => `+${l.telefono} ${l.nombre ?? ""} ${formatoCita(l.cita!, tz)}, ${l.modalidad ?? ""}, ${l.pago_confirmado ? "pagada" : "SIN PAGO"}`);
    if (citas.length) lineas.push("", "Evaluaciones hoy y mañana:", ...citas);
    lineas.push(
      "",
      `Ayer: ${nuevos} leads nuevos, ${enviados.length} mensajes enviados, ${respuestas.length} mensajes de leads, ${agendadas.n} evaluaciones agendadas.` +
        (unicas.length >= 5
          ? ` Espera: mediana ${mediana} min, ${mas15} sobre 15 min, la más lenta ${peor!.min} min (+${peor!.tel}).`
          : unicas.length
            ? ` Espera: ${unicas.length} respuestas medidas, la más lenta ${peor!.min} min (+${peor!.tel}).`
            : ""),
    );
    return lineas.join("\n");
  }

  private reporteSombra(ahora: Date): string {
    const p = partesLocales(ahora, this.cfg.TZ_NEGOCIO);
    const inicioHoy = new Date(`${p.fecha}T00:00:00-05:00`);
    const inicioAyer = new Date(inicioHoy.getTime() - DIA);
    const filas = this.comparacionSombra(inicioAyer, inicioHoy);
    const respuestas = filas.filter((f) => f.modo === "respuesta");
    const sinReal = respuestas.filter((f) => !f.real.length).length;
    const tiempos = respuestas.map((f) => f.minutosReal).filter((x): x is number => x != null).sort((a, b) => a - b);
    const escaladas = filas.filter((f) => f.accion?.startsWith("Escala")).length;
    const fecha = partesLocales(inicioAyer, this.cfg.TZ_NEGOCIO).fecha;
    const enlace = this.cfg.URL_PUBLICA ? `${this.cfg.URL_PUBLICA.replace(/\/$/, "")}/panel/sombra?fecha=${fecha}&token=${this.cfg.ADMIN_API_TOKEN}` : "(configura URL_PUBLICA para el enlace)";
    return [
      `Modo sombra, ayer: el agente revisó ${filas.length} momentos sin enviar nada.`,
      `${respuestas.length} respuestas propuestas, ${escaladas} casos que habría dejado a Mario, ${filas.filter((f) => f.modo === "riesgo").length} alertas de riesgo.`,
      tiempos.length ? `Respuesta real (rondas o Mario): mediana ${tiempos[Math.floor(tiempos.length / 2)]} min, la más lenta ${tiempos.at(-1)} min. ${sinReal} mensajes de leads sin respuesta real.` : "",
      `Comparación lado a lado: ${enlace}`,
    ]
      .filter(Boolean)
      .join("\n");
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
          if (this.sombra) return responder("Modo sombra: no se envía nada a los leads. Respóndele desde la app.");
          const id = Number(resto[0]);
          const esc = this.store.escalacion(id);
          if (!esc || esc.estado !== "pendiente") return responder(`No hay escalación pendiente #${resto[0]}.`);
          const tel = esc.telefono;
          const lead = this.store.lead(tel)!;
          const accion = esc.accion ? JSON.parse(esc.accion) : null;
          const partes =
            cmd === "OK"
              ? accion?.mensajes
                ? (accion.mensajes as { texto: string }[]).map((m) => m.texto)
                : (esc.propuesta ?? "").split(SEPARADOR).map((x) => x.trim()).filter((x) => x && !/^\[(enviar cuenta|registrar comprobante)/.test(x))
              : texto.replace(/^\S+\s+\S+\s*/, "").split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
          if (!partes.length && !accion) return responder(`La escalación #${id} no tiene propuesta. Usa EDITAR ${id} <texto>.`);

          // Fuera de las 24 h desde el último mensaje del lead, WhatsApp no deja enviar texto libre por la API.
          if (!ventanaAbierta(lead.ultimo_in, this.reloj())) {
            if (this.cfg.SEGUIMIENTO_FUERA_DE_VENTANA !== "chrome" || !partes.length) {
              return responder(`Con +${tel} pasaron más de 24 h desde su último mensaje: por la API solo se pueden enviar plantillas. Escríbele tú desde la app y luego IGNORAR ${id}.`);
            }
            this.store.agregarParaChrome(tel, partesLocales(this.reloj(), this.cfg.TZ_NEGOCIO).fecha, partes.join("\n\n"), `aprobado por Mario (#${id})`);
            this.store.cerrarEscalacion(id, cmd === "OK" ? "enviada" : "editada");
            this.reanudarSiNoQuedan(tel);
            return responder(`Con +${tel} pasaron más de 24 h: el texto quedó en la lista de seguimientos para que lo envíe la ronda de Chrome.`);
          }

          let resultado = `Enviado a +${tel}.`;
          if (accion?.marcarPagado && cmd === "OK") {
            // Mario ya creó el evento a mano (así lo pedía la escalación): solo se confirma y se registra el pago.
            resultado = `+${tel}: ${await this.registrarComprobante(tel, "confirmado por Mario", { porMario: true, sinEvento: true })}.`;
          } else {
            const autor = cmd === "OK" ? "agente_aprobado" : "mario";
            const mensajes =
              cmd === "OK" && accion?.mensajes ? accion.mensajes : partes.map((t) => ({ texto: t, tipo: "respuesta", profundizar: false, reflejo: false }));
            await this.ejecutar(tel, { mensajes, datosPago: accion?.datosPago ?? null, comprobante: null }, "respuesta", accion?.respondeA ?? null, autor);
            if (accion?.comprobante) await this.registrarComprobante(tel, accion.comprobante, { porMario: true });
            if (accion?.marcarPagado) {
              this.store.actualizar(tel, { pago_confirmado: 1, etapa: "Agendo sesion Evaluacion", paso: "agendado", proximo_toque: null });
            }
          }
          this.store.cerrarEscalacion(id, cmd === "OK" ? "enviada" : "editada");
          this.reanudarSiNoQuedan(tel);
          this.marcarLeidoUltimo(tel);
          return responder(resultado);
        }
        case "IGNORAR": {
          const id = Number(resto[0]);
          const esc = this.store.escalacion(id);
          if (!esc) return responder(`No existe la escalación #${resto[0]}.`);
          this.store.cerrarEscalacion(id, "ignorada");
          this.reanudarSiNoQuedan(esc.telefono, esc.categoria !== "riesgo");
          return responder(`#${id} cerrada.${esc.categoria === "riesgo" ? ` El chat sigue en pausa por riesgo: REANUDAR ${esc.telefono} cuando corresponda.` : ""}`);
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
          this.store.actualizar(tel, { dueno: dueno as Dueno });
          for (const e of this.store.escalacionesPendientes().filter((x) => x.telefono === tel && x.categoria === "asignar_dueno")) {
            this.store.cerrarEscalacion(e.id, "editada");
          }
          if (l.motivo_pausa?.startsWith("chat iniciado desde la app")) this.reanudarSiNoQuedan(tel);
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
          // PAGADO 0991234567 [2026-11-27 15:00 presencial]
          const tel = normalizarTelefono(resto[0] ?? "");
          const lead = this.store.lead(tel);
          if (!lead) return responder(`No conozco +${tel}.`);
          if (resto[1] && resto[2]) {
            this.store.actualizar(tel, { cita: desdeLocal(`${resto[1]}T${resto[2]}`).toISOString(), modalidad: resto[3]?.startsWith("pres") ? "presencial" : lead.modalidad ?? "en línea" });
          }
          if (!this.store.lead(tel)!.cita) return responder("Falta la fecha: PAGADO <tel> AAAA-MM-DD HH:MM [presencial|linea]");
          if (this.sombra) return responder("Modo sombra: no se envía nada a los leads ni se crea el evento.");
          if (!ventanaAbierta(this.store.lead(tel)!.ultimo_in, this.reloj())) {
            return responder(`Con +${tel} pasaron más de 24 h desde su último mensaje: confirma tú desde la app. No registré nada.`);
          }
          return responder(`+${tel}: ${await this.registrarComprobante(tel, "confirmado por Mario", { porMario: true })}.`);
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
        case "REPORTE":
          return responder(this.reporteDiario(this.reloj()));
        case "ESTADO": {
          const tel = normalizarTelefono(resto[0] ?? "");
          const l = this.store.lead(tel);
          if (!l) return responder(`No conozco +${tel}.`);
          return responder(
            `+${tel} ${l.nombre ?? ""}\nDueño: ${l.dueno} | Etapa: ${l.etapa} | Paso: ${l.paso}\nPausado: ${l.pausado ? `sí (${l.motivo_pausa})` : "no"}\nCita: ${l.cita ? formatoCita(l.cita, this.cfg.TZ_NEGOCIO) : "-"}\nPróximo toque: ${l.proximo_toque ?? "-"}`,
          );
        }
        default:
          return responder(
            [
              "Comandos:",
              "OK <n> | EDITAR <n> <texto> | IGNORAR <n>",
              "PENDIENTES | REPORTE | ESTADO <tel>",
              "PAUSA <tel> | REANUDAR <tel>",
              "DUEÑO <tel> MARIO|DANI|VERO",
              "ETAPA <tel> <etapa>",
              "PAGADO <tel> [AAAA-MM-DD HH:MM presencial|linea] | CONVERTIDO <tel>",
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
    if (!quedan && reanudar && l && !l.motivo_pausa?.startsWith("riesgo")) this.reanudar(tel);
  }

  /** Quita la pausa; si el lead escribió mientras tanto, queda pendiente para el agente; y reprograma el seguimiento. */
  private reanudar(tel: string): void {
    const ahora = this.reloj();
    const ultimo = this.store.mensajes(tel, 1)[0];
    const l = this.store.lead(tel)!;
    this.store.actualizar(tel, {
      pausado: 0,
      motivo_pausa: null,
      pendiente_desde: ultimo?.direccion === "in" ? ahora.toISOString() : null,
      responder_despues: ultimo?.direccion === "in" ? new Date(ahora.getTime() + this.lectura(ultimo.texto)).toISOString() : null,
      proximo_toque: this.calcularProximoToque(l, ahora),
    });
  }
}

function textoEscalacion(e: Escalacion, lead: Lead | null, inmediato: boolean): string {
  const urgente = inmediato && ["riesgo", "reclamo", "identidad"].includes(e.categoria);
  return [
    `${urgente ? "URGENTE " : ""}[#${e.id}] ${e.categoria.toUpperCase()} | +${e.telefono}${lead?.nombre ? ` (${lead.nombre})` : ""}${lead ? ` | chat de ${lead.dueno}` : ""}`,
    `Motivo: ${e.motivo}`,
    e.propuesta ? `Propuesta:\n${e.propuesta}` : null,
    e.propuesta ? `Responde: OK ${e.id} | EDITAR ${e.id} <texto> | IGNORAR ${e.id}` : `Cuando lo atiendas: IGNORAR ${e.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function resumir(t: string, n = 200): string {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Los parámetros de plantilla no aceptan saltos de línea ni más de 4 espacios seguidos. */
function paraPlantilla(t: string): string {
  return resumir(t.replace(/\n+/g, " / "), 900);
}
