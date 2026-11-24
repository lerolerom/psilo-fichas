import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { Store } from "./db.js";
import { WhatsAppCloud } from "./whatsapp.js";
import { AgenteSetter } from "./agent/agente.js";
import { GoogleCalendario, SinCalendario } from "./calendario.js";
import { Motor } from "./motor.js";
import { crearApp } from "./app.js";

const store = new Store(config.DB_PATH);
const wa = new WhatsAppCloud({
  phoneNumberId: config.WA_PHONE_NUMBER_ID,
  token: config.WA_ACCESS_TOKEN,
  version: config.WA_GRAPH_VERSION,
  idioma: config.PLANTILLA_IDIOMA,
});

const calendario =
  config.GOOGLE_SERVICE_ACCOUNT_JSON && config.GOOGLE_CALENDAR_ID
    ? new GoogleCalendario(config.GOOGLE_SERVICE_ACCOUNT_JSON, config.GOOGLE_CALENDAR_ID, config.TZ_NEGOCIO, config.feriados)
    : null;

const agente = new AgenteSetter(
  new Anthropic(),
  { modelo: config.CLAUDE_MODEL, effort: config.CLAUDE_EFFORT },
  calendario ?? new SinCalendario(),
);
const motor = new Motor(config, store, wa, agente, calendario);

const app = crearApp(config, store, motor);
app.listen(config.PORT, () => {
  console.log(`Setter de Despertar escuchando en :${config.PORT} (modo ${config.MODO})`);
});

let corriendo = false;
setInterval(async () => {
  if (corriendo) return;
  corriendo = true;
  try {
    await motor.tick();
  } catch (e) {
    console.error("tick", e);
  } finally {
    corriendo = false;
  }
}, 20_000);
