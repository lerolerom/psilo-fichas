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
  // Inteligencia escalonada (decisión de Mario, 25 nov 2026): Haiku para lo rutinario, Sonnet para los momentos
  // delicados (precio, objeciones, reflejo, comprobantes) y Opus solo si un nivel inferior no lo resuelve.
  MODELO_BASICO: z.string().default("claude-haiku-5-5"),
  MODELO_MEDIO: z.string().default("claude-sonnet-5-5"),
  MODELO_SUPERIOR: z.string().default("claude-opus-5-5"),
  EFFORT_BASICO: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  EFFORT_MEDIO: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  EFFORT_SUPERIOR: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  // Tope mensual de gasto en Claude (USD). Al llegar, solo se usa el modelo básico (el agente nunca deja de contestar).
  PRESUPUESTO_MENSUAL_USD: z.coerce.number().default(45),

  // WhatsApp Cloud API
  WA_GRAPH_VERSION: z.string().default("v23.0"),
  WA_PHONE_NUMBER_ID: z.string().default(""),
  WA_ACCESS_TOKEN: z.string().default(""),
  WA_APP_SECRET: z.string().default(""),
  WA_VERIFY_TOKEN: z.string().default(""),
  // Página de Facebook (para leer leads de formularios instantáneos)
  META_PAGE_ACCESS_TOKEN: z.string().default(""),

  // Operación
  // sombra: recibe todo y decide, pero no envía nada (para comparar con las rondas de Chrome antes de pasar).
  MODO: z.enum(["sombra", "hibrido", "aprobacion", "pausado"]).default("sombra"),
  // Seguimientos fuera de las 24 h: plantillas aprobadas, o una lista con el texto propuesto que envían las rondas de Chrome.
  SEGUIMIENTO_FUERA_DE_VENTANA: z.enum(["plantillas", "chrome"]).default("chrome"),
  // Meta: API de Conversiones (para que Meta aprenda qué leads califican). Del Administrador de eventos.
  META_DATASET_ID: z.string().default(""),
  META_CAPI_TOKEN: z.string().default(""),
  META_WABA_ID: z.string().default(""), // ID de la cuenta de WhatsApp Business (para eventos de anuncios a WhatsApp)
  META_NOMBRE_CRM: z.string().default("Despertar Setter"),
  // Nombre del evento que se envía por cada etapa (el de formularios usa el nombre de la etapa tal cual).
  META_EVENTOS_WHATSAPP: z.string().default("Qualified:QualifiedLead,Agendo sesion Evaluacion:Schedule,Converted:Purchase"),
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
  // Horarios (decisión de Mario, 24 nov 2026): se contesta toda la noche con tiempo de "lectura";
  // los seguimientos van de lunes a viernes, alternando mañana y tarde, a horas que varían.
  LECTURA_MIN_MINUTOS: z.coerce.number().default(3),
  LECTURA_MAX_MINUTOS: z.coerce.number().default(10),
  ESPERA_TRAS_MARIO_MINUTOS: z.coerce.number().default(10), // si Mario escribió desde la app, se le da este margen
  FRANJAS_SEGUIMIENTO: z.string().default("09:00-12:00,15:00-18:30"),
  HORARIO_EVALUACIONES: z.string().default("09:00-19:00"), // entre semana; la evaluación debe terminar antes del fin
  HORA_REPORTE_DIARIO: z.string().default("07:50"),
  // Audios: Whisper en un contenedor propio (API compatible con OpenAI). Vacío = los audios se escalan.
  WHISPER_URL: z.string().default(""),
  WHISPER_MODELO: z.string().default("Systran/faster-whisper-small"),
  AVISOS_INMEDIATOS: z.string().default("riesgo,reclamo,caliente,identidad"),
  FERIADOS: z.string().default(""), // YYYY-MM-DD separados por coma
  MAX_MENSAJES_HORA: z.coerce.number().default(60),
  ADMIN_API_TOKEN: z.string().default(""),
  URL_PUBLICA: z.string().default(""), // ej. https://setter.despertar.ec (para los enlaces del panel en el reporte)

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

  // Google Calendar de Mario. Recomendado: OAuth con su cuenta (permite crear links de Meet).
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REFRESH_TOKEN: z.string().default(""),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default(""), // alternativa sin Meet
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
});

export function crearConfig(fuente: Record<string, string | undefined>) {
  const env = Env.parse(fuente);
  return {
  ...env,
  adminNumeros: lista(env.ADMIN_NUMEROS).map(normalizarTelefono),
  notificarA: lista(env.NOTIFICAR_A || env.ADMIN_NUMEROS).map(normalizarTelefono),
  feriados: new Set(lista(env.FERIADOS)),
  avisosInmediatos: new Set(lista(env.AVISOS_INMEDIATOS)),
  franjasSeguimiento: lista(env.FRANJAS_SEGUIMIENTO).map(rango).filter((r): r is [number, number] => !!r),
  horarioEvaluaciones: rango(env.HORARIO_EVALUACIONES) ?? [9 * 60, 19 * 60],
};
}

export const config = crearConfig(process.env);

/** "08:00-09:30" -> minutos desde medianoche [480, 570]. Vacío -> null. */
export function rango(v: string): [number, number] | null {
  const m = v.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
}

export type Config = ReturnType<typeof crearConfig>;

/** Normaliza a formato E.164 sin "+": 0991234567 -> 593991234567. */
export function normalizarTelefono(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("09")) d = "593" + d.slice(1);
  if (d.startsWith("5930")) d = "593" + d.slice(4);
  return d;
}
