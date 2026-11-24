/**
 * Conecta el Google Calendar de Mario una sola vez y devuelve el GOOGLE_REFRESH_TOKEN para el .env.
 * Córrelo en una computadora con navegador (por ejemplo la de Mario), no en el servidor:
 * 1) En Google Cloud Console habilita "Google Calendar API" y crea un "ID de cliente OAuth" tipo "App de escritorio".
 * 2) GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run autorizar-google
 * 3) Abre el enlace, entra con la cuenta de Mario y acepta. El token aparece en la terminal.
 */
import http from "node:http";
import { OAuth2Client } from "google-auth-library";

const id = process.env.GOOGLE_CLIENT_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) {
  console.error("Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.");
  process.exit(1);
}
const PUERTO = 53682;
const client = new OAuth2Client(id, secret, `http://127.0.0.1:${PUERTO}`);
const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/calendar"] });

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url ?? "/", `http://127.0.0.1:${PUERTO}`).searchParams.get("code");
  if (!code) {
    res.end("Sin código.");
    return;
  }
  const { tokens } = await client.getToken(code);
  res.end("Listo. Ya puedes cerrar esta pestaña y volver a la terminal.");
  console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  server.close();
});
server.listen(PUERTO, () => console.log(`Abre este enlace con la cuenta de Mario:\n\n${url}\n`));
