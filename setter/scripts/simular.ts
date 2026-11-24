/**
 * Simulador de conversación en la terminal: tú escribes como lead y ves qué haría el agente
 * (mensajes, etapa, escalaciones) sin tocar WhatsApp. Usa Claude de verdad (necesita ANTHROPIC_API_KEY).
 *
 * Uso: npm run simular -- [--formulario "Tengo ansiedad desde hace años"] [--nombre Ana] [--tel 0991234567]
 */
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline/promises";
import { config, normalizarTelefono } from "../src/config.js";
import { Store } from "../src/db.js";
import { AgenteSetter } from "../src/agent/agente.js";
import { SinCalendario } from "../src/calendario.js";
import { Motor } from "../src/motor.js";
import type { WhatsApp } from "../src/whatsapp.js";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const tel = arg("tel") ?? "0991234567";
let n = 0;
const wa: WhatsApp = {
  async enviarTexto(to, texto) {
    const quien = config.adminNumeros.includes(to) || to === "593000000000" ? "A MARIO" : "AL LEAD";
    console.log(`\n\x1b[36m[${quien}]\x1b[0m ${texto}`);
    return `sim-${++n}`;
  },
  async enviarPlantilla(to, nombre, params) {
    console.log(`\n\x1b[35m[PLANTILLA ${nombre} -> ${to}]\x1b[0m ${params.join(" | ")}`);
    return `sim-${++n}`;
  },
  async marcarLeido() {},
};

const cfg = {
  ...config,
  LECTURA_MIN_MINUTOS: 0,
  LECTURA_MAX_MINUTOS: 0,
  notificarA: config.notificarA.length ? config.notificarA : ["593000000000"],
  adminNumeros: config.adminNumeros.length ? config.adminNumeros : ["593000000000"],
};
const store = new Store(":memory:");
const agente = new AgenteSetter(new Anthropic(), { modelo: cfg.CLAUDE_MODEL, effort: cfg.CLAUDE_EFFORT }, new SinCalendario());
let desfase = 0;
const reloj = () => new Date(Date.now() + desfase);
const motor = new Motor(cfg, store, wa, agente, null, { reloj, dormir: async () => {} });

const formulario = arg("formulario");
if (formulario !== undefined) {
  await motor.ingresarLead({ telefono: tel, nombre: arg("nombre") ?? null, formulario, origen: "formulario", anuncio: null });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Escribe como el lead. Comandos de Mario: empieza con '/' (ej. /OK 1). Enter vacío = avanzar el reloj 1 día. Ctrl+C para salir.");
await motor.tick();

let i = 0;
for (;;) {
  const linea = await rl.question("\n\x1b[33mlead>\x1b[0m ");
  if (linea.startsWith("/")) {
    await motor.comandoAdmin(cfg.adminNumeros[0], linea.slice(1));
  } else if (linea.trim() === "") {
    desfase += 24 * 3600_000;
    console.log(`(reloj +1 día: ${reloj().toISOString()})`);
  } else {
    await motor.procesar([
      { tipo: "entrante", de: normalizarTelefono(tel), nombrePerfil: arg("nombre") ?? null, waId: `in-${++i}`, ts: reloj(), clase: "text", texto: linea, referral: null },
    ]);
  }
  desfase += 61_000; // pasa el minuto mínimo de "lectura"
  await motor.tick();
  const l = store.lead(normalizarTelefono(tel));
  if (l) console.log(`\x1b[90m  etapa=${l.etapa} paso=${l.paso} pausado=${l.pausado ? l.motivo_pausa : "no"} proximo_toque=${l.proximo_toque ?? "-"}\x1b[0m`);
}

