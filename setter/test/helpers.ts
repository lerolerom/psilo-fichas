import { Store } from "../src/db.js";
import { Motor } from "../src/motor.js";
import type { WhatsApp } from "../src/whatsapp.js";
import { decisionVacia, type AgenteSetter, type Decision, type EntradaAgente } from "../src/agent/agente.js";
import { crearConfig } from "../src/config.js";

export const MARIO = "593990000001";
export const MIN = 60_000;

export function decision(p: Partial<Decision> = {}): Decision {
  return { ...decisionVacia(), ...p };
}

export const msg = (texto: string, extra: Partial<Decision["mensajes"][number]> = {}) => ({
  texto,
  tipo: "respuesta" as const,
  profundizar: false,
  reflejo: false,
  ...extra,
});

export function montar(
  opts: {
    decisiones?: Decision[];
    env?: Record<string, string>;
    ahora?: Date;
    calendario?: { crearEvaluacion: (...a: any[]) => Promise<{ link: string; meet: string | null }> } | null;
    transcripcion?: string | null;
  } = {},
) {
  const enviados: { to: string; texto: string; plantilla?: string }[] = [];
  const entradas: EntradaAgente[] = [];
  const escribiendo: string[] = [];
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
    async escribiendo(waId) {
      escribiendo.push(waId);
    },
    async descargarMedia() {
      return { mime: "audio/ogg", data: Buffer.from("x") };
    },
  };
  const cola = [...(opts.decisiones ?? [])];
  const agente = {
    async decidir(e: EntradaAgente) {
      entradas.push(e);
      return cola.shift() ?? decision({ noResponder: "sin guion" });
    },
  } as unknown as AgenteSetter;

  const cfg = crearConfig({
    ADMIN_NUMEROS: MARIO,
    DATOS_TRANSFERENCIA: "PRODUBANCO|Ahorros: 0000000000|Titular: PRUEBA",
    DIRECCION_CUMBAYA: "Cumbayá, lote de prueba",
    TELEFONO_DANIELA: "+593 98 000 0000",
    HORA_REPORTE_DIARIO: "23:59",
    ...opts.env,
  });

  // Martes 24 nov 2026, 10:00 en Quito (15:00 UTC)
  let ahora = opts.ahora ?? new Date("2026-11-24T15:00:00Z");
  const store = new Store(":memory:");
  const motor = new Motor(cfg, store, wa, agente, (opts.calendario as any) ?? null, {
    reloj: () => ahora,
    azar: () => 0.5,
    dormir: async () => {},
    transcriptor: opts.transcripcion === undefined ? null : { transcribir: async () => opts.transcripcion ?? null },
  });
  return {
    cfg,
    store,
    motor,
    enviados,
    entradas,
    escribiendo,
    cola,
    alLead: (tel: string) => enviados.filter((e) => e.to === tel),
    aMario: () => enviados.filter((e) => e.to === MARIO),
    avanzar(ms: number) {
      ahora = new Date(ahora.getTime() + ms);
    },
    get ahora() {
      return ahora;
    },
    entrante(de: string, texto: string, waId: string, clase = "text", mediaId?: string) {
      return motor.procesar([{ tipo: "entrante", de, nombrePerfil: null, waId, ts: ahora, clase, texto, referral: null, mediaId }]);
    },
    eco(para: string, texto: string, waId: string) {
      return motor.procesar([{ tipo: "eco", para, waId, ts: ahora, clase: "text", texto }]);
    },
  };
}
