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
import {
  DIA,
  HORA,
  type Horario,
  dentroDeHorario,
  desdeLocal,
  diasDesde,
  enRango,
  esFinDeSemana,
  formatoCita,
  partesLocales,
  proximoToque,
  siguienteMomentoPermitido,
  ventanaAbierta,
} from "./tiempo.js";

export interface CalendarioEscritura {
  crearEvaluacion(inicioIso: string, titulo: string, descripcion: string, minutos?: number): Promise<string>;
}

type Entrante = Extract<EventoWA, { tipo: "entrante" }>;
type Eco = Extract<EventoWA, { tipo: "eco" }>;
type Modo = "respuesta" | "seguimiento" | "recordatorio";

const SIN_SEGUIMIENTO = new Set(["Converted", "Agendo sesion Evaluacion"]);
const MEDIA_VISIBLE = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;

export class Motor {
  private hResp: Horario;
  private hSeg: Horario;
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
    this.hResp = { tz: cfg.TZ_NEGOCIO, horaInicio: cfg.HORA_INICIO_ENVIO, horaFin: cfg.HORA_FIN_ENVIO, feriados: cfg.feriados };
    this.hSeg = { tz: cfg.TZ_NEGOCIO, horaInicio: cfg.HORA_INICIO_SEGUIMIENTO, horaFin: cfg.HORA_FIN_SEGUIMIENTO, feriados: cfg.feriados };
  }

  // =====================================================================
  // Entradas
  // =====================================================================

  async procesar(eventos: EventoWA[]): Promise<void> {
    for (const ev of eventos) {
      try {
        if (ev.tipo === "entrante") await this.entrante(ev);
        else if (ev.tipo === "eco") await this.eco(ev);
        else if (ev.tipo === "estado" && ev.estado === "failed") this.store.log(ev.para, "envio_fallido", ev.error);
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

  private enFranjaVero(d: Date): boolean {
    return !esFinDeSemana(d, this.cfg.TZ_NEGOCIO) && enRango(d, this.cfg.TZ_NEGOCIO, this.cfg.franjaVero);
  }

  private enVentanaSeguimientos(d: Date): boolean {
    return enRango(d, this.cfg.TZ_NEGOCIO, this.cfg.ventanaSeguimientos);
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

    // Historial sincronizado al activar la coexistencia: solo se guarda.
    if (ev.historial) {
      this.store.actualizar(ev.de, { historial_incompleto: 1 });
      return;
    }

    if (ev.mediaId && this.wa.descargarMedia) await this.guardarAdjunto(ev.waId, ev.mediaId);
    if (ev.formulario) {
      this.store.actualizar(ev.de, { formulario: [lead.formulario, ev.formulario].filter(Boolean).join("\n"), origen: lead.origen ?? "formulario" });
    }

    // Chats de Vero: no se leen ni se contestan, y quedan como no leídos.
    // Única excepción: una señal de riesgo se avisa a los fundadores (sin escribirle al lead).
    if (lead.dueno === "VERO") {
      if (detectarRiesgo(ev.texto)) {
        await this.notificar(`URGENTE: posible señal de riesgo en un chat de VERO (+${ev.de}). No se respondió nada. Mensaje: "${resumir(ev.texto)}"`);
      }
      return;
    }

    const cambios: Partial<Lead> = { ultimo_in: ahora.toISOString(), intentos_sin_respuesta: 0, proximo_toque: null };
    if (lead.paso === "contactado" || lead.paso === "nuevo") cambios.paso = "abrio";

    // Riesgo: antes que cualquier otra cosa y a cualquier hora, sin pasar por el agente de ventas.
    const riesgo = detectarRiesgo(ev.texto);
    if (riesgo) {
      this.store.actualizar(ev.de, { ...cambios, pausado: 1, motivo_pausa: `riesgo ${riesgo}`, pendiente_desde: null });
      const lead2 = this.store.lead(ev.de)!;
      if (riesgo === "alto" && this.cfg.MODO !== "pausado") {
        await this.enviarTexto(lead2, mensajeContencion(lead2.nombre), { autor: "sistema", tipo: "otro", respondeA: ev.ts.toISOString() });
      }
      await this.escalar(lead2, {
        categoria: "riesgo",
        motivo:
          riesgo === "alto"
            ? `Posible riesgo de autolesión. Se envió mensaje de contención con 171 opción 6 y 911. Mensaje: "${ev.texto}"`
            : `Señal ambigua de riesgo. No se respondió nada. Mensaje: "${ev.texto}"`,
        propuesta: null,
      });
      return;
    }

    if (lead.pausado) {
      this.store.actualizar(ev.de, cambios);
      if (lead.motivo_pausa?.startsWith("riesgo")) {
        await this.notificar(`URGENTE: +${ev.de}${lead.nombre ? ` (${lead.nombre})` : ""}, caso de riesgo, volvió a escribir: "${resumir(ev.texto || `[${ev.clase}]`)}"`);
      }
      return; // su caso ya está para Mario; aparece en el reporte diario
    }

    if (lead.humano_hasta && new Date(lead.humano_hasta) > ahora) {
      this.store.actualizar(ev.de, cambios); // alguien del equipo está llevando el chat
      return;
    }

    this.store.actualizar(ev.de, { ...cambios, pendiente_desde: lead.pendiente_desde ?? ahora.toISOString() });
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
    if (!lead) {
      // Chat iniciado desde la app: no sabemos de quién es. Por seguridad, el agente no lo toca.
      lead = this.store.crearLead(ev.para, { dueno: this.cfg.DUENO_POR_DEFECTO, origen: "app" }, ahora);
      this.store.actualizar(ev.para, {
        pausado: ev.historial ? 0 : 1,
        motivo_pausa: ev.historial ? null : "chat iniciado desde la app: asignar dueño con DUEÑO",
      });
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
    const cambios: Partial<Lead> = {
      humano_hasta: new Date(ahora.getTime() + this.cfg.HUMANO_SILENCIO_HORAS * HORA).toISOString(),
      pendiente_desde: null,
      ultimo_out: ahora.toISOString(),
    };
    // Franja de Vero: si el primer mensaje a un lead nuevo sale de la app en esa franja, es de Vero.
    if (primeroNuestro && this.enFranjaVero(ahora) && lead.origen !== "app") cambios.dueno = "VERO";
    this.store.actualizar(ev.para, cambios);
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
    // Primer contacto (abandonados incluidos: "estos leads sí se escriben"): lo hace el ciclo de seguimiento.
    this.store.actualizar(tel, { proximo_toque: siguienteMomentoPermitido(ahora, this.hSeg, false).toISOString() });
    return this.store.lead(tel)!;
  }

  // =====================================================================
  // Ciclo periódico
  // =====================================================================

  async tick(): Promise<void> {
    const ahora = this.reloj();
    await this.quizasReporteDiario(ahora);
    if (this.cfg.MODO === "pausado") return;

    // 1) Respuestas. En la ventana de seguimientos (08:00 a 09:30) no se contestan mensajes (Mario, 23 nov 2026).
    if (!this.enVentanaSeguimientos(ahora) && dentroDeHorario(ahora, this.hResp)) {
      const limite = new Date(ahora.getTime() - this.cfg.DEBOUNCE_SEGUNDOS * 1000);
      for (const lead of this.store.leadsConPendientes(limite)) {
        if (!this.hayCupo(ahora)) break;
        if (this.esperaFranjaVero(lead, ahora)) continue;
        await this.conCandado(lead.telefono, () => this.turno(lead.telefono, "respuesta"));
      }
    }

    // 2) Seguimientos, primeros contactos y recordatorios de cita: 08:00 a 21:59, todos los días.
    if (dentroDeHorario(ahora, this.hSeg)) {
      await this.recordatoriosDeCita(ahora);
      for (const lead of this.store.leadsConToqueVencido(ahora)) {
        if (!this.hayCupo(ahora)) break;
        await this.conCandado(lead.telefono, () => this.seguimiento(lead.telefono));
      }
    }

    this.reglasDePaso(ahora);
  }

  /** En la franja de Vero, un lead nuevo es de Vero salvo que lleve más de 15 minutos sin respuesta. */
  private esperaFranjaVero(lead: Lead, ahora: Date): boolean {
    if (!this.enFranjaVero(ahora)) return false;
    if (this.nuestros(lead.telefono).length > 0 || lead.historial_incompleto) return false;
    const desde = new Date(lead.pendiente_desde ?? lead.creado).getTime();
    return ahora.getTime() - desde < this.cfg.FRANJA_VERO_ESPERA_MIN * 60_000;
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

  private async turno(tel: string, modo: Modo): Promise<void> {
    const lead = this.store.lead(tel);
    if (!lead || lead.pausado || lead.dueno === "VERO") {
      if (lead) this.store.actualizar(tel, { pendiente_desde: null });
      return;
    }
    const ahora = this.reloj();
    const mensajes = this.store.mensajes(tel);
    const h = hechos(lead, mensajes, this.cfg.VIDEO_EDUCATIVO_URL);
    const texto = armarContexto(lead, mensajes, { modo, ahora, tz: this.cfg.TZ_NEGOCIO, material: this.material(lead) });

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
    const d = await this.agente.decidir({
      texto,
      adjuntos,
      estado: { chatNuevo: h.chatNuevo, preguntasProfundizar: lead.preguntas_profundizar, precioEvaluacionDado: h.precioEvaluacionDado },
    });
    this.store.log(tel, "decision", JSON.stringify(d));
    this.store.actualizar(tel, { pendiente_desde: null });
    await this.aplicar(lead, d, modo, respondeA);
  }

  private async aplicar(lead: Lead, d: Decision, modo: Modo, respondeA: string | null): Promise<void> {
    const tel = lead.telefono;
    const ahora = this.reloj();

    for (const x of d.datos) {
      const l = this.store.lead(tel)!;
      if (x.campo === "nombre") this.store.actualizar(tel, { nombre: x.valor });
      else if (x.campo === "ciudad") this.store.actualizar(tel, { ciudad: x.valor });
      else if (x.campo === "nota") this.store.actualizar(tel, { notas: [l.notas, x.valor].filter(Boolean).join(" | ") });
      else if (x.campo === "aprendizaje") this.store.log(tel, "aprendizaje", x.valor);
      else if (x.campo === "no_explicito") this.store.actualizar(tel, { dijo_no: 1 });
      else if (x.campo === "fecha_acordada") this.store.actualizar(tel, { fecha_acordada: x.valor });
      else if (x.campo === "oferta_dani") {
        const v = { ofrecida: 1, aceptada: 2, rechazada: 3 }[x.valor as "ofrecida"] ?? 1;
        this.store.actualizar(tel, { oferta_dani: v, ...(v === 3 ? { dijo_no: 1 } : {}) });
      }
    }
    const actual = this.store.lead(tel)!;
    const etapa = etapaFinal(actual.etapa, d.etapa);
    if (etapa !== actual.etapa) this.store.actualizar(tel, { etapa });
    if (d.paso) this.store.actualizar(tel, { paso: d.paso });

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

    if (d.noResponder && !d.mensajes.length && !d.datosPago && !d.comprobante) {
      this.marcarLeidoUltimo(tel);
      return;
    }

    // Modo aprobación: todo pasa por Mario.
    if (this.cfg.MODO === "aprobacion" && d.mensajes.length) {
      const propuesta = d.mensajes.map((m) => m.texto).join("\n\n");
      await this.escalar(this.store.lead(tel)!, { categoria: "aprobacion", motivo: "Respuesta para aprobar", propuesta });
      return;
    }

    let enviados = 0;
    for (const m of d.mensajes) {
      await this.enviarTexto(this.store.lead(tel)!, m.texto, { autor: "agente", tipo: m.tipo, respondeA });
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
    const intentos = modo === "respuesta" ? 0 : l.intentos_sin_respuesta + 1;
    const cambios: Partial<Lead> = { intentos_sin_respuesta: intentos };
    if (l.paso === "nuevo") cambios.paso = "contactado";
    cambios.proximo_toque = this.calcularProximoToque({ ...l, ...cambios } as Lead, ahora);
    this.store.actualizar(tel, cambios);
    this.marcarLeidoUltimo(tel);
  }

  private calcularProximoToque(l: Lead, ahora: Date): string | null {
    if (l.dijo_no || SIN_SEGUIMIENTO.has(l.etapa) || l.paso === "agendado" || l.paso === "cerrado") return null;
    return proximoToque(ahora, diasDesde(l.ultimo_in ?? l.creado, ahora), this.hSeg, l.fecha_acordada).toISOString();
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
      { autor: "sistema", tipo: "otro" },
    );
    await this.enviarTexto(
      this.store.lead(tel)!,
      `Y este es el formulario que se llena antes de la sesión de evaluación: ${this.cfg.FORMULARIO_EVALUACION_URL}`,
      { autor: "sistema", tipo: "otro" },
    );
    this.store.actualizar(tel, { datos_pago_enviados: 1, horario_ofrecido: 1 });
    return 2;
  }

  /** Con el comprobante: evento en el calendario principal, confirmación, formulario y dirección si es presencial. */
  private async registrarComprobante(tel: string, evidencia: string): Promise<void> {
    const lead = this.store.lead(tel)!;
    if (!lead.cita) {
      await this.escalar(lead, { categoria: "otro", motivo: `Envió un comprobante (${evidencia}) pero no hay día y hora acordados en el sistema.`, propuesta: null });
      return;
    }
    const nombre = (lead.nombre ?? "").split(" ")[0];
    const cuando = formatoCita(lead.cita, this.cfg.TZ_NEGOCIO);
    const modalidad = lead.modalidad === "presencial" ? "presencial en Cumbayá" : "en línea";
    const confirmacion = `${nombre ? `${nombre}, q` : "Q"}uedó agendada tu evaluación para el ${cuando}, ${modalidad}. Te escribo un día antes para recordártelo.`;

    if (!this.calendario) {
      await this.escalar(lead, {
        categoria: "agendar",
        motivo: `Comprobante recibido (${evidencia}) para ${cuando}, ${modalidad}. Calendario no conectado: crea tú el evento "Sesión de evaluación con ${lead.nombre ?? tel}" y aprueba la confirmación.`,
        propuesta: confirmacion,
      });
      return;
    }
    await this.calendario.crearEvaluacion(
      lead.cita,
      `Sesión de evaluación con ${lead.nombre ?? `+${tel}`}`,
      `Nombre: ${lead.nombre ?? "-"}\nTeléfono: +${tel}\nModalidad: ${modalidad}\nComprobante: ${evidencia}`,
      this.cfg.DURACION_EVALUACION_MIN,
    );
    await this.enviarTexto(lead, confirmacion, { autor: "sistema", tipo: "evaluación" });
    await this.enviarTexto(
      this.store.lead(tel)!,
      `Antes de la sesión necesito que llenes este formulario, siempre se llena antes de la evaluación: ${this.cfg.FORMULARIO_EVALUACION_URL}`,
      { autor: "sistema", tipo: "otro" },
    );
    if (lead.modalidad === "presencial" && this.cfg.DIRECCION_CUMBAYA) {
      await this.enviarTexto(
        this.store.lead(tel)!,
        `La dirección es ${this.cfg.DIRECCION_CUMBAYA}.${this.cfg.MAPS_URL ? ` Aquí la ubicación: ${this.cfg.MAPS_URL}` : ""}`,
        { autor: "sistema", tipo: "otro" },
      );
    }
    this.store.actualizar(tel, { pago_confirmado: 1, etapa: "Agendo sesion Evaluacion", paso: "agendado", proximo_toque: null });
    this.store.log(tel, "evaluacion_agendada", `${lead.cita} ${modalidad}`);
    this.marcarLeidoUltimo(tel);
  }

  /** Día anterior a la cita: recordar y confirmar asistencia (y el pago si falta). Mismo día si no pagó. */
  private async recordatoriosDeCita(ahora: Date): Promise<void> {
    const hoy = partesLocales(ahora, this.cfg.TZ_NEGOCIO).fecha;
    const manana = partesLocales(new Date(ahora.getTime() + DIA), this.cfg.TZ_NEGOCIO).fecha;
    for (const l of this.store.leadsConCita()) {
      if (l.pausado || l.dueno === "VERO" || l.etapa === "Converted" || l.etapa === "Lost") continue;
      const diaCita = partesLocales(new Date(l.cita!), this.cfg.TZ_NEGOCIO).fecha;
      if (new Date(l.cita!) <= ahora) continue;
      const toca = diaCita === manana || (diaCita === hoy && !l.pago_confirmado);
      if (!toca || l.recordatorio_cita === hoy) continue;
      this.store.actualizar(l.telefono, { recordatorio_cita: hoy });
      await this.conCandado(l.telefono, async () => {
        if (ventanaAbierta(l.ultimo_in, ahora)) return this.turno(l.telefono, "recordatorio");
        const nombre = (l.nombre ?? "").split(" ")[0] || "hola";
        const hora = new Date(l.cita!).toLocaleTimeString("es-EC", { timeZone: this.cfg.TZ_NEGOCIO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        await this.enviarPlantilla(l, this.cfg.PLANTILLA_RECORDATORIO_EVALUACION, [nombre, diaCita === hoy ? "hoy" : "mañana", hora]);
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
    if (lead.fecha_acordada && new Date(`${lead.fecha_acordada}T08:00:00-05:00`) > ahora) {
      this.store.actualizar(tel, { proximo_toque: siguienteMomentoPermitido(new Date(`${lead.fecha_acordada}T08:00:00-05:00`), this.hSeg, false).toISOString() });
      return;
    }

    // Dentro de las 24 h desde su último mensaje: el agente redacta un toque a medida.
    if (ventanaAbierta(lead.ultimo_in, ahora)) return this.turno(tel, "seguimiento");

    // Fuera de la ventana: solo plantillas aprobadas por Meta.
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

  private async enviarTexto(lead: Lead, texto: string, o: { autor: string; tipo?: string; respondeA?: string | null }): Promise<void> {
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
    const ultimo = [...this.store.mensajes(tel, 10)].reverse().find((m) => m.direccion === "in" && m.wa_id);
    if (ultimo?.wa_id) this.wa.marcarLeido(ultimo.wa_id).catch(() => {});
  }

  private async escalar(
    lead: Lead,
    e: { categoria: string; motivo: string; propuesta: string | null; pausar?: boolean },
  ): Promise<Escalacion> {
    const esc = this.store.crearEscalacion({ telefono: lead.telefono, categoria: e.categoria, motivo: e.motivo, propuesta: e.propuesta });
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

  reporteDiario(ahora: Date): string {
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
            await this.enviarTexto(this.store.lead(esc.telefono) ?? lead, parte, { autor: cmd === "OK" ? "agente_aprobado" : "mario", tipo: "respuesta" });
          }
          this.store.cerrarEscalacion(id, cmd === "OK" ? "enviada" : "editada");
          this.reanudarSiNoQuedan(esc.telefono);
          const l = this.store.lead(esc.telefono)!;
          this.store.actualizar(esc.telefono, { intentos_sin_respuesta: 0, proximo_toque: this.calcularProximoToque(l, this.reloj()) });
          this.marcarLeidoUltimo(esc.telefono);
          return responder(`Enviado a +${esc.telefono}.`);
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
          // PAGADO 0991234567 [2026-11-27 15:00 presencial]
          const tel = normalizarTelefono(resto[0] ?? "");
          const lead = this.store.lead(tel);
          if (!lead) return responder(`No conozco +${tel}.`);
          if (resto[1] && resto[2]) {
            this.store.actualizar(tel, { cita: desdeLocal(`${resto[1]}T${resto[2]}`).toISOString(), modalidad: resto[3]?.startsWith("pres") ? "presencial" : lead.modalidad ?? "en línea" });
          }
          if (!this.store.lead(tel)!.cita) return responder("Falta la fecha: PAGADO <tel> AAAA-MM-DD HH:MM [presencial|linea]");
          await this.registrarComprobante(tel, "confirmado por Mario");
          return responder(`+${tel}: evaluación agendada y confirmada al lead.`);
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
