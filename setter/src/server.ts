import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { Store } from "./db.js";
import { WhatsAppCloud } from "./whatsapp.js";
import { AgenteSetter } from "./agent/agente.js";
import { GoogleCalendario, SinCalendario } from "./calendario.js";
import { Motor } from "./motor.js";
import { WhisperLocal } from "./transcriptor.js";
import { MetaConversiones } from "./meta.js";
import { crearApp } from "./app.js";

const store = new Store(config.DB_PATH);
const wa = new WhatsAppCloud({
  phoneNumberId: config.WA_PHONE_NUMBER_ID,
  token: config.WA_ACCESS_TOKEN,
  version: config.WA_GRAPH_VERSION,
  idioma: config.PLANTILLA_IDIOMA,
});

const calendario =
  config.GOOGLE_REFRESH_TOKEN || config.GOOGLE_SERVICE_ACCOUNT_JSON
    ? new GoogleCalendario(
        {
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
          refreshToken: config.GOOGLE_REFRESH_TOKEN,
          serviceAccountJson: config.GOOGLE_SERVICE_ACCOUNT_JSON,
        },
        config.GOOGLE_CALENDAR_ID,
        config.TZ_NEGOCIO,
        config.feriados,
        config.horarioEvaluaciones,
      )
    : null;

const agente = new AgenteSetter(
  new Anthropic(),
  { modelo: config.CLAUDE_MODEL, effort: config.CLAUDE_EFFORT },
  calendario ?? new SinCalendario(),
  config.DURACION_EVALUACION_MIN,
);
const transcriptor = config.WHISPER_URL ? new WhisperLocal(config.WHISPER_URL, config.WHISPER_MODELO) : null;
const conversiones =
  config.META_DATASET_ID && config.META_CAPI_TOKEN
    ? new MetaConversiones({
        datasetId: config.META_DATASET_ID,
        token: config.META_CAPI_TOKEN,
        wabaId: config.META_WABA_ID,
        version: config.WA_GRAPH_VERSION,
        nombreCrm: config.META_NOMBRE_CRM,
        eventosWhatsapp: config.META_EVENTOS_WHATSAPP,
      })
    : null;
const motor = new Motor(config, store, wa, agente, calendario, { transcriptor, conversiones });

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
