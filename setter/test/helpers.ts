import { Store } from "../src/db.js";
import { Motor } from "../src/motor.js";
import type { WhatsApp } from "../src/whatsapp.js";
import type { AgenteSetter, Decision } from "../src/agent/agente.js";
import type { Config } from "../src/config.js";

export const MARIO = "593990000001";

export function decision(p: Partial<Decision> = {}): Decision {
  return { mensajes: [], enviarVideo: false, escalacion: null, etapa: null, paso: null, datos: [], noResponder: null, rechazo: false, ...p };
}

export function montar(opts: { decisiones?: Decision[]; cfg?: Partial<Config>; ahora?: Date } = {}) {
  const enviados: { to: string; texto: string; plantilla?: string }[] = [];
  const contextos: string[] = [];
  let id = 0;
  const wa: WhatsApp = {
    async enviarTexto(to, texto) {
      enviados.push({ to, texto });
      return `out-${++id}`;
    },
    async enviarPlantilla(to, nombre, params) {
      enviados.push({ to, texto: params.join("|"), plantilla: nombre });
      return `out-${++id}`;
    },
    async marcarLeido() {},
  };
  const cola = [...(opts.decisiones ?? [])];
  const agente = {
    async decidir(ctx: string) {
      contextos.push(ctx);
      return cola.shift() ?? decision({ noResponder: "sin guion" });
    },
  } as unknown as AgenteSetter;

  const cfg = {
    PORT: 0,
    DB_PATH: ":memory:",
    TZ_NEGOCIO: "America/Guayaquil",
    CLAUDE_MODEL: "x",
    CLAUDE_EFFORT: "medium",
    WA_GRAPH_VERSION: "v23.0",
    WA_PHONE_NUMBER_ID: "",
    WA_ACCESS_TOKEN: "",
    WA_APP_SECRET: "",
    WA_VERIFY_TOKEN: "",
    META_PAGE_ACCESS_TOKEN: "",
    MODO: "hibrido",
    ADMIN_NUMEROS: MARIO,
    NOTIFICAR_A: MARIO,
    DUENO_POR_DEFECTO: "MARIO",
    PRESENTACION_MARIO: "Mario",
    PRESENTACION_DANI: "",
    VIDEO_EDUCATIVO_URL: "https://youtu.be/video",
    DEBOUNCE_SEGUNDOS: 60,
    HUMANO_SILENCIO_HORAS: 12,
    HORA_INICIO_ENVIO: 8,
    HORA_FIN_ENVIO: 21,
    FERIADOS: "",
    MAX_MENSAJES_HORA: 60,
    ADMIN_API_TOKEN: "t",
    PLANTILLA_IDIOMA: "es",
    PLANTILLA_ALERTA: "alerta_setter",
    PLANTILLA_PRIMER_CONTACTO: "primer_contacto_formulario",
    PLANTILLA_PRIMER_CONTACTO_SIN_RESPUESTA: "primer_contacto_sin_respuesta",
    PLANTILLA_SEGUIMIENTO_CONTACTADO: "seguimiento_contactado_1,seguimiento_contactado_2",
    PLANTILLA_SEGUIMIENTO_CONVERSANDO: "seguimiento_conversando_1,seguimiento_conversando_2",
    PLANTILLA_SEGUIMIENTO_OFRECIDO: "seguimiento_ofrecido_1,seguimiento_ofrecido_2",
    GOOGLE_SERVICE_ACCOUNT_JSON: "",
    GOOGLE_CALENDAR_ID: "",
    adminNumeros: [MARIO],
    notificarA: [MARIO],
    feriados: new Set<string>(),
    ...opts.cfg,
  } as Config;

  // Martes 24 nov 2026, 10:00 en Quito (15:00 UTC)
  let ahora = opts.ahora ?? new Date("2026-11-24T15:00:00Z");
  const store = new Store(":memory:");
  const motor = new Motor(cfg, store, wa, agente, null, () => ahora);
  return {
    store,
    motor,
    enviados,
    contextos,
    cola,
    avanzar(ms: number) {
      ahora = new Date(ahora.getTime() + ms);
    },
    get ahora() {
      return ahora;
    },
    entrante(de: string, texto: string, waId: string, clase = "text") {
      return motor.procesar([{ tipo: "entrante", de, nombrePerfil: null, waId, ts: ahora, clase, texto, referral: null }]);
    },
  };
}
