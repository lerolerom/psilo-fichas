import { z } from "zod";

const lista = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const Env = z.object({
  PORT: z.coerce.number().default(3000),
  DB_PATH: z.string().default("./data/setter.db"),
  TZ_NEGOCIO: z.string().default("America/Guayaquil"),

  // Claude
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  // WhatsApp Cloud API
  WA_GRAPH_VERSION: z.string().default("v23.0"),
  WA_PHONE_NUMBER_ID: z.string().default(""),
  WA_ACCESS_TOKEN: z.string().default(""),
  WA_APP_SECRET: z.string().default(""),
  WA_VERIFY_TOKEN: z.string().default(""),
  // Página de Facebook (para leer leads de formularios instantáneos)
  META_PAGE_ACCESS_TOKEN: z.string().default(""),

  // Operación
  MODO: z.enum(["hibrido", "aprobacion", "pausado"]).default("hibrido"),
  ADMIN_NUMEROS: z.string().default(""), // números de Mario/Dani que pueden dar órdenes, formato 593XXXXXXXXX
  NOTIFICAR_A: z.string().default(""), // a quién avisar escalaciones (por defecto, ADMIN_NUMEROS)
  DUENO_POR_DEFECTO: z.enum(["MARIO", "DANI", "VERO"]).default("MARIO"),
  PRESENTACION_MARIO: z.string().default("Mario"),
  PRESENTACION_DANI: z.string().default(""), // vacío = pendiente de Mario: se escala el primer mensaje
  // Material y datos del negocio (manual, sección 4 y 5). Los datos bancarios NO van en el código.
  VIDEO_EDUCATIVO_URL: z.string().default("https://youtu.be/cuMOrmOdzIU"),
  TESTIMONIOS_URL: z.string().default("https://youtube.com/playlist?list=PLi-B534urCtaEamepwTBLf7-zsGvprNho"),
  FORMULARIO_EVALUACION_URL: z.string().default("https://forms.gle/wwHVNHk3GUw1B2Sg6"),
  DATOS_TRANSFERENCIA: z.string().default(""), // líneas separadas por "|": Banco: ...|Ahorros: ...|Titular: ...|CI: ...|Mail: ...
  DIRECCION_CUMBAYA: z.string().default(""),
  MAPS_URL: z.string().default(""),
  TELEFONO_DANIELA: z.string().default(""), // para la derivación a terapia con Daniela (lista Terapia Dani)
  DURACION_EVALUACION_MIN: z.coerce.number().default(45),
  // Horarios (decisiones de Mario del 20 al 23 nov 2026)
  VENTANA_SEGUIMIENTOS: z.string().default("08:00-09:30"), // vacío = sin ventana; en ella no se contestan mensajes
  FRANJA_VERO: z.string().default("15:00-17:00"), // lunes a viernes; vacío = sin franja
  FRANJA_VERO_ESPERA_MIN: z.coerce.number().default(15),
  HORA_REPORTE_DIARIO: z.string().default("07:50"),
  AVISOS_INMEDIATOS: z.string().default("riesgo,reclamo,caliente,identidad"),
  DEBOUNCE_SEGUNDOS: z.coerce.number().default(90),
  HUMANO_SILENCIO_HORAS: z.coerce.number().default(12),
  // Respuestas: 24 horas (Mario prefiere contestar también de noche). Seguimientos: 08:00 a 21:59.
  HORA_INICIO_ENVIO: z.coerce.number().default(0),
  HORA_FIN_ENVIO: z.coerce.number().default(24),
  HORA_INICIO_SEGUIMIENTO: z.coerce.number().default(8),
  HORA_FIN_SEGUIMIENTO: z.coerce.number().default(22),
  FERIADOS: z.string().default(""), // YYYY-MM-DD separados por coma
  MAX_MENSAJES_HORA: z.coerce.number().default(60),
  ADMIN_API_TOKEN: z.string().default(""),

  // Plantillas aprobadas por Meta (fuera de la ventana de 24 h)
  PLANTILLA_IDIOMA: z.string().default("es"),
  PLANTILLA_ALERTA: z.string().default("alerta_setter"),
  PLANTILLA_PRIMER_CONTACTO: z.string().default("primer_contacto_formulario"),
  PLANTILLA_PRIMER_CONTACTO_SIN_RESPUESTA: z.string().default("primer_contacto_sin_respuesta"),
  PLANTILLA_ABANDONADO: z.string().default("primer_contacto_abandonado"),
  PLANTILLA_RECORDATORIO_EVALUACION: z.string().default("recordatorio_evaluacion"),
  PLANTILLA_RECONEXION_1: z.string().default("reconexion_1"),
  PLANTILLA_RECONEXION_2: z.string().default("reconexion_2"),
  PLANTILLA_RECONEXION_3: z.string().default("reconexion_3"),
  // Listas separadas por coma: se rotan en cada toque.
  PLANTILLA_SEGUIMIENTO_CONTACTADO: z.string().default("seguimiento_contactado_1,seguimiento_contactado_2"),
  PLANTILLA_SEGUIMIENTO_CONVERSANDO: z.string().default("seguimiento_conversando_1,seguimiento_conversando_2"),
  PLANTILLA_SEGUIMIENTO_OFRECIDO: z.string().default("seguimiento_ofrecido_1,seguimiento_ofrecido_2"),

  // Google Calendar (opcional)
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default(""),
  GOOGLE_CALENDAR_ID: z.string().default(""),
});

const env = Env.parse(process.env);

export const config = {
  ...env,
  adminNumeros: lista(env.ADMIN_NUMEROS).map(normalizarTelefono),
  notificarA: lista(env.NOTIFICAR_A || env.ADMIN_NUMEROS).map(normalizarTelefono),
  feriados: new Set(lista(env.FERIADOS)),
  avisosInmediatos: new Set(lista(env.AVISOS_INMEDIATOS)),
  ventanaSeguimientos: rango(env.VENTANA_SEGUIMIENTOS),
  franjaVero: rango(env.FRANJA_VERO),
};

/** "08:00-09:30" -> minutos desde medianoche [480, 570]. Vacío -> null. */
export function rango(v: string): [number, number] | null {
  const m = v.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
}

export type Config = typeof config;

/** Normaliza a formato E.164 sin "+": 0991234567 -> 593991234567. */
export function normalizarTelefono(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("09")) d = "593" + d.slice(1);
  if (d.startsWith("5930")) d = "593" + d.slice(4);
  return d;
}
