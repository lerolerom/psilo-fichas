import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Dueno = "MARIO" | "DANI" | "VERO";

/** Etapas de Meta / WhatsApp (manual del setter). */
export const ETAPAS = [
  "Intake",
  "Qualified",
  "Agendo sesion Evaluacion",
  "Converted",
  "Lost",
  "Not qualified",
] as const;
export type Etapa = (typeof ETAPAS)[number];

/** Paso de la conversación: define qué seguimiento corresponde. */
export const PASOS = [
  "nuevo",
  "contactado",
  "abrio",
  "conectado",
  "educado",
  "ofrecido",
  "comprometido",
  "agendado",
  "cerrado",
] as const;
export type Paso = (typeof PASOS)[number];

export interface Lead {
  telefono: string;
  nombre: string | null;
  dueno: Dueno;
  etapa: Etapa;
  paso: Paso;
  origen: string | null; // formulario | instagram | ctwa | abandonado | directo
  formulario: string | null; // lo que escribió en el formulario
  anuncio: string | null;
  ciudad: string | null;
  pausado: number; // 1 = el agente no escribe
  motivo_pausa: string | null;
  humano_hasta: string | null; // ISO: alguien del equipo escribió desde la app
  ultimo_in: string | null;
  ultimo_out: string | null;
  pendiente_desde: string | null; // ISO: mensajes del lead sin procesar
  intentos_sin_respuesta: number;
  proximo_toque: string | null;
  video_enviado: number;
  horario_ofrecido: number;
  notas: string | null;
  creado: string;
  // Reglas del manual vigente (nov 2026)
  preguntas_profundizar: number; // tope 3, después va el reflejo
  reflejo_enviado: number;
  pregunto_conoce_terapia: number;
  precio_evaluacion_dado: number; // ya recibió los $40
  precio_programa_dado: number; // ya recibió "desde $490"
  datos_pago_enviados: number;
  cita: string | null; // ISO de la evaluación acordada
  modalidad: string | null; // en línea | presencial
  pago_confirmado: number;
  recordatorio_cita: string | null; // ISO del último recordatorio de pago/asistencia enviado
  dijo_no: number; // no explícito a todo: sale del seguimiento
  oferta_dani: number; // 0 no ofrecida, 1 ofrecida, 2 aceptó, 3 rechazó
  historial_incompleto: number; // chat anterior al sistema: nunca plantilla de primer mensaje
  fecha_acordada: string | null; // "escríbeme en enero": no se escribe antes
  responder_despues: string | null; // ISO: tiempo de "lectura" antes de contestar
  leadgen_id: string | null; // ID del lead de formulario instantáneo (API de Conversiones para CRM)
  ctwa_clid: string | null; // ID del clic en anuncio a WhatsApp (API de Conversiones para mensajería)
}

export interface Sombra {
  id: number;
  telefono: string;
  modo: string; // respuesta | seguimiento | recordatorio | riesgo
  ts_lead: string | null; // mensaje del lead al que responde
  ts_propuesta: string;
  decision: string; // JSON de la decisión del agente
  contexto_hasta: string | null; // último mensaje que vio el agente
}

export interface Mensaje {
  id: number;
  tipo_envio?: string | null; // [Tipo: X] del manual (primer mensaje, detalle, hipotética, ...)
  responde_a?: string | null; // ISO del mensaje del lead al que responde (latencia)
  media_path?: string | null;
  telefono: string;
  direccion: "in" | "out" | "eco" | "nota";
  tipo: string;
  texto: string;
  wa_id: string | null;
  autor: string | null; // agente | mario | app | plantilla | sistema
  ts: string;
}

export const TIPOS_ENVIO = [
  "primer mensaje",
  "hipotética",
  "detalle",
  "evaluación",
  "precio",
  "testimonio",
  "video",
  "Dani",
  "reconexión",
  "respuesta",
  "otro",
] as const;

export interface Escalacion {
  id: number;
  telefono: string;
  categoria: string;
  motivo: string;
  propuesta: string | null;
  estado: "pendiente" | "enviada" | "editada" | "ignorada";
  creado: string;
  avisada: number; // 1 = ya se le avisó a Mario (inmediato o en el reporte diario)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  telefono TEXT PRIMARY KEY,
  nombre TEXT,
  dueno TEXT NOT NULL DEFAULT 'MARIO',
  etapa TEXT NOT NULL DEFAULT 'Intake',
  paso TEXT NOT NULL DEFAULT 'nuevo',
  origen TEXT,
  formulario TEXT,
  anuncio TEXT,
  ciudad TEXT,
  pausado INTEGER NOT NULL DEFAULT 0,
  motivo_pausa TEXT,
  humano_hasta TEXT,
  ultimo_in TEXT,
  ultimo_out TEXT,
  pendiente_desde TEXT,
  intentos_sin_respuesta INTEGER NOT NULL DEFAULT 0,
  proximo_toque TEXT,
  video_enviado INTEGER NOT NULL DEFAULT 0,
  horario_ofrecido INTEGER NOT NULL DEFAULT 0,
  notas TEXT,
  creado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  direccion TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'text',
  texto TEXT NOT NULL DEFAULT '',
  wa_id TEXT UNIQUE,
  autor TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mensajes_tel_ts ON mensajes(telefono, ts);
CREATE INDEX IF NOT EXISTS idx_mensajes_tel ON mensajes(telefono, id);
CREATE TABLE IF NOT EXISTS escalaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  categoria TEXT NOT NULL,
  motivo TEXT NOT NULL,
  propuesta TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  creado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (clave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS sombra (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  modo TEXT NOT NULL,
  ts_lead TEXT,
  ts_propuesta TEXT NOT NULL,
  decision TEXT NOT NULL,
  contexto_hasta TEXT
);
CREATE TABLE IF NOT EXISTS eventos_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  etapa TEXT NOT NULL,
  ts TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  intentos INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS para_chrome (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  fecha TEXT NOT NULL,
  propuesta TEXT NOT NULL,
  motivo TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  UNIQUE(telefono, fecha)
);
CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT,
  evento TEXT NOT NULL,
  detalle TEXT,
  ts TEXT NOT NULL
);
`;

export class Store {
  readonly db: Database.Database;
  /** Se llama cada vez que cambia la etapa de un lead (para enviar el evento a Meta). */
  onCambioEtapa?: (telefono: string, anterior: Etapa, nueva: Etapa) => void;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrar();
  }

  /** Columnas agregadas después de la primera versión (idempotente). */
  private migrar(): void {
    const tiene = (tabla: string, col: string) =>
      (this.db.prepare(`PRAGMA table_info(${tabla})`).all() as { name: string }[]).some((c) => c.name === col);
    const nuevas: [string, string, string][] = [
      ["leads", "preguntas_profundizar", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "reflejo_enviado", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "pregunto_conoce_terapia", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "precio_evaluacion_dado", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "precio_programa_dado", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "datos_pago_enviados", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "cita", "TEXT"],
      ["leads", "modalidad", "TEXT"],
      ["leads", "pago_confirmado", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "recordatorio_cita", "TEXT"],
      ["leads", "dijo_no", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "oferta_dani", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "historial_incompleto", "INTEGER NOT NULL DEFAULT 0"],
      ["leads", "fecha_acordada", "TEXT"],
      ["leads", "responder_despues", "TEXT"],
      ["leads", "leadgen_id", "TEXT"],
      ["leads", "ctwa_clid", "TEXT"],
      ["mensajes", "tipo_envio", "TEXT"],
      ["escalaciones", "avisada", "INTEGER NOT NULL DEFAULT 0"],
      ["mensajes", "media_path", "TEXT"],
      ["mensajes", "responde_a", "TEXT"], // ISO del mensaje del lead al que responde (latencia)
    ];
    for (const [t, c, def] of nuevas) if (!tiene(t, c)) this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  }

  // ---------- leads ----------
  lead(telefono: string): Lead | undefined {
    return this.db.prepare("SELECT * FROM leads WHERE telefono = ?").get(telefono) as Lead | undefined;
  }

  crearLead(telefono: string, datos: Partial<Lead> & { dueno: Dueno }, ahora = new Date()): Lead {
    const existente = this.lead(telefono);
    if (existente) return existente;
    this.db
      .prepare(
        `INSERT INTO leads (telefono, nombre, dueno, origen, formulario, anuncio, creado)
         VALUES (@telefono, @nombre, @dueno, @origen, @formulario, @anuncio, @creado)`,
      )
      .run({
        telefono,
        nombre: datos.nombre ?? null,
        dueno: datos.dueno,
        origen: datos.origen ?? null,
        formulario: datos.formulario ?? null,
        anuncio: datos.anuncio ?? null,
        creado: ahora.toISOString(),
      });
    this.log(telefono, "lead_creado", JSON.stringify(datos));
    return this.lead(telefono)!;
  }

  actualizar(telefono: string, cambios: Partial<Omit<Lead, "telefono">>): void {
    const claves = Object.keys(cambios);
    if (!claves.length) return;
    const anterior = cambios.etapa && this.onCambioEtapa ? this.lead(telefono)?.etapa : undefined;
    const set = claves.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE leads SET ${set} WHERE telefono = @telefono`).run({ ...cambios, telefono });
    if (anterior && cambios.etapa && anterior !== cambios.etapa) this.onCambioEtapa!(telefono, anterior, cambios.etapa);
  }

  // ---------- modo sombra ----------
  guardarSombra(s: Omit<Sombra, "id">): void {
    this.db
      .prepare(
        "INSERT INTO sombra (telefono, modo, ts_lead, ts_propuesta, decision, contexto_hasta) VALUES (@telefono, @modo, @ts_lead, @ts_propuesta, @decision, @contexto_hasta)",
      )
      .run(s);
  }

  sombraEntre(desde: Date, hasta: Date): Sombra[] {
    return this.db
      .prepare("SELECT * FROM sombra WHERE ts_propuesta >= ? AND ts_propuesta < ? ORDER BY ts_propuesta")
      .all(desde.toISOString(), hasta.toISOString()) as Sombra[];
  }

  // ---------- eventos para Meta ----------
  encolarEventoMeta(telefono: string, etapa: string, ts: Date): void {
    this.db.prepare("INSERT INTO eventos_meta (telefono, etapa, ts) VALUES (?, ?, ?)").run(telefono, etapa, ts.toISOString());
  }

  eventosMetaPendientes(): { id: number; telefono: string; etapa: string; ts: string; intentos: number }[] {
    return this.db.prepare("SELECT * FROM eventos_meta WHERE estado = 'pendiente' AND intentos < 5 ORDER BY id LIMIT 50").all() as any[];
  }

  marcarEventoMeta(id: number, ok: boolean, error?: string): void {
    if (ok) this.db.prepare("UPDATE eventos_meta SET estado = 'enviado', error = NULL WHERE id = ?").run(id);
    else this.db.prepare("UPDATE eventos_meta SET intentos = intentos + 1, error = ? WHERE id = ?").run(error ?? null, id);
  }

  // ---------- lista para las rondas de Chrome ----------
  agregarParaChrome(telefono: string, fecha: string, propuesta: string, motivo: string): void {
    this.db
      .prepare(
        "INSERT INTO para_chrome (telefono, fecha, propuesta, motivo) VALUES (?, ?, ?, ?) ON CONFLICT(telefono, fecha) DO UPDATE SET propuesta = excluded.propuesta, motivo = excluded.motivo",
      )
      .run(telefono, fecha, propuesta, motivo);
  }

  listaChrome(fecha: string): { id: number; telefono: string; fecha: string; propuesta: string; motivo: string; estado: string }[] {
    return this.db.prepare("SELECT * FROM para_chrome WHERE fecha = ? ORDER BY id").all(fecha) as any[];
  }

  /** Leads con mensajes sin contestar cuyo tiempo de "lectura" ya pasó. */
  leadsListosParaResponder(ahora: Date): Lead[] {
    return this.db
      .prepare(
        "SELECT * FROM leads WHERE pendiente_desde IS NOT NULL AND COALESCE(responder_despues, pendiente_desde) <= ? ORDER BY pendiente_desde",
      )
      .all(ahora.toISOString()) as Lead[];
  }

  leadsConToqueVencido(ahora: Date): Lead[] {
    return this.db
      .prepare(
        "SELECT * FROM leads WHERE proximo_toque IS NOT NULL AND proximo_toque <= ? AND pausado = 0 AND dueno != 'VERO'",
      )
      .all(ahora.toISOString()) as Lead[];
  }

  todos(): Lead[] {
    return this.db.prepare("SELECT * FROM leads ORDER BY creado").all() as Lead[];
  }

  // ---------- mensajes ----------
  guardarMensaje(m: Omit<Mensaje, "id"> & { responde_a?: string | null }): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO mensajes (telefono, direccion, tipo, texto, wa_id, autor, ts, tipo_envio, responde_a)
         VALUES (@telefono, @direccion, @tipo, @texto, @wa_id, @autor, @ts, @tipo_envio, @responde_a)`,
      )
      .run({ tipo_envio: null, responde_a: null, ...m });
    return r.changes > 0;
  }

  /** Mensajes en un rango de tiempo (para el reporte diario). */
  mensajesEntre(desde: Date, hasta: Date): Mensaje[] {
    return this.db
      .prepare("SELECT * FROM mensajes WHERE ts >= ? AND ts < ? ORDER BY ts")
      .all(desde.toISOString(), hasta.toISOString()) as Mensaje[];
  }

  leadsConCita(): Lead[] {
    return this.db.prepare("SELECT * FROM leads WHERE cita IS NOT NULL").all() as Lead[];
  }

  mensajes(telefono: string, limite = 80): Mensaje[] {
    const filas = this.db
      .prepare("SELECT * FROM mensajes WHERE telefono = ? ORDER BY id DESC LIMIT ?")
      .all(telefono, limite) as Mensaje[];
    return filas.reverse();
  }

  contarSalientesUltimaHora(ahora: Date): number {
    const desde = new Date(ahora.getTime() - 3600_000).toISOString();
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM mensajes WHERE direccion = 'out' AND ts >= ?")
      .get(desde) as { n: number };
    return r.n;
  }

  // ---------- escalaciones ----------
  crearEscalacion(e: Omit<Escalacion, "id" | "estado" | "creado" | "avisada">): Escalacion {
    const r = this.db
      .prepare(
        `INSERT INTO escalaciones (telefono, categoria, motivo, propuesta, creado)
         VALUES (@telefono, @categoria, @motivo, @propuesta, @creado)`,
      )
      .run({ ...e, creado: new Date().toISOString() });
    return this.escalacion(Number(r.lastInsertRowid))!;
  }

  escalacion(id: number): Escalacion | undefined {
    return this.db.prepare("SELECT * FROM escalaciones WHERE id = ?").get(id) as Escalacion | undefined;
  }

  escalacionesPendientes(): Escalacion[] {
    return this.db
      .prepare("SELECT * FROM escalaciones WHERE estado = 'pendiente' ORDER BY id")
      .all() as Escalacion[];
  }

  marcarAvisada(id: number): void {
    this.db.prepare("UPDATE escalaciones SET avisada = 1 WHERE id = ?").run(id);
  }

  cerrarEscalacion(id: number, estado: Escalacion["estado"]): void {
    this.db.prepare("UPDATE escalaciones SET estado = ? WHERE id = ?").run(estado, id);
  }

  kv(clave: string): string | null {
    const r = this.db.prepare("SELECT valor FROM kv WHERE clave = ?").get(clave) as { valor: string } | undefined;
    return r?.valor ?? null;
  }

  setKv(clave: string, valor: string): void {
    this.db.prepare("INSERT INTO kv (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(clave, valor);
  }

  ponerTexto(waId: string, texto: string): void {
    this.db.prepare("UPDATE mensajes SET texto = ? WHERE wa_id = ?").run(texto, waId);
  }

  ponerMedia(waId: string, ruta: string): void {
    this.db.prepare("UPDATE mensajes SET media_path = ? WHERE wa_id = ?").run(ruta, waId);
  }

  log(telefono: string | null, evento: string, detalle?: string): void {
    this.db
      .prepare("INSERT INTO bitacora (telefono, evento, detalle, ts) VALUES (?, ?, ?, ?)")
      .run(telefono, evento, detalle ?? null, new Date().toISOString());
  }
}
