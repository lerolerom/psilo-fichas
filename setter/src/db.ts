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
}

export interface Mensaje {
  id: number;
  telefono: string;
  direccion: "in" | "out" | "eco" | "nota";
  tipo: string;
  texto: string;
  wa_id: string | null;
  autor: string | null; // agente | mario | app | plantilla | sistema
  ts: string;
}

export interface Escalacion {
  id: number;
  telefono: string;
  categoria: string;
  motivo: string;
  propuesta: string | null;
  estado: "pendiente" | "enviada" | "editada" | "ignorada";
  creado: string;
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

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
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
    const set = claves.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE leads SET ${set} WHERE telefono = @telefono`).run({ ...cambios, telefono });
  }

  leadsConPendientes(antesDe: Date): Lead[] {
    return this.db
      .prepare("SELECT * FROM leads WHERE pendiente_desde IS NOT NULL AND pendiente_desde <= ?")
      .all(antesDe.toISOString()) as Lead[];
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
  guardarMensaje(m: Omit<Mensaje, "id">): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO mensajes (telefono, direccion, tipo, texto, wa_id, autor, ts)
         VALUES (@telefono, @direccion, @tipo, @texto, @wa_id, @autor, @ts)`,
      )
      .run(m);
    return r.changes > 0;
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
  crearEscalacion(e: Omit<Escalacion, "id" | "estado" | "creado">): Escalacion {
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

  cerrarEscalacion(id: number, estado: Escalacion["estado"]): void {
    this.db.prepare("UPDATE escalaciones SET estado = ? WHERE id = ?").run(estado, id);
  }

  log(telefono: string | null, evento: string, detalle?: string): void {
    this.db
      .prepare("INSERT INTO bitacora (telefono, evento, detalle, ts) VALUES (?, ?, ?, ?)")
      .run(telefono, evento, detalle ?? null, new Date().toISOString());
  }
}
