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
  VIDEO_EDUCATIVO_URL: z.string().default(""),
  DEBOUNCE_SEGUNDOS: z.coerce.number().default(90),
  HUMANO_SILENCIO_HORAS: z.coerce.number().default(12),
  HORA_INICIO_ENVIO: z.coerce.number().default(8),
  HORA_FIN_ENVIO: z.coerce.number().default(21),
  FERIADOS: z.string().default(""), // YYYY-MM-DD separados por coma
  MAX_MENSAJES_HORA: z.coerce.number().default(60),
  ADMIN_API_TOKEN: z.string().default(""),

  // Plantillas aprobadas por Meta (fuera de la ventana de 24 h)
  PLANTILLA_IDIOMA: z.string().default("es"),
  PLANTILLA_ALERTA: z.string().default("alerta_setter"),
  PLANTILLA_PRIMER_CONTACTO: z.string().default("primer_contacto_formulario"),
  PLANTILLA_PRIMER_CONTACTO_SIN_RESPUESTA: z.string().default("primer_contacto_sin_respuesta"),
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
};

export type Config = typeof config;

/** Normaliza a formato E.164 sin "+": 0991234567 -> 593991234567. */
export function normalizarTelefono(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("09")) d = "593" + d.slice(1);
  if (d.startsWith("5930")) d = "593" + d.slice(4);
  return d;
}
