import { GoogleAuth } from "google-auth-library";
import type { Calendario } from "./agent/agente.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

/** Google Calendar con cuenta de servicio (el calendario de evaluaciones debe estar compartido con ella). */
export class GoogleCalendario implements Calendario {
  private auth: GoogleAuth;

  constructor(
    credencialesJson: string,
    private calendarId: string,
    private tz: string,
    private feriados: Set<string>,
  ) {
    this.auth = new GoogleAuth({ credentials: JSON.parse(credencialesJson), scopes: SCOPES });
  }

  private async api(path: string, init: { method: string; body?: unknown }) {
    const client = await this.auth.getClient();
    const res = await client.request({
      url: `https://www.googleapis.com/calendar/v3/${path}`,
      method: init.method as "GET" | "POST",
      data: init.body,
    });
    return res.data as any;
  }

  async ocupado(fecha: string): Promise<string> {
    const dia = new Date(`${fecha}T12:00:00-05:00`);
    const dow = dia.getUTCDay();
    if (dow === 0 || dow === 6) return `${fecha} es fin de semana: no se atiende. Pide otro día entre semana.`;
    if (this.feriados.has(fecha)) return `${fecha} es feriado: no se atiende. Pide otro día.`;
    const data = await this.api("freeBusy", {
      method: "POST",
      body: {
        timeMin: `${fecha}T08:00:00-05:00`,
        timeMax: `${fecha}T19:00:00-05:00`,
        timeZone: this.tz,
        items: [{ id: this.calendarId }],
      },
    });
    const busy: { start: string; end: string }[] = data.calendars?.[this.calendarId]?.busy ?? [];
    if (!busy.length) return `${fecha}: libre de 08:00 a 19:00 (hora de Ecuador).`;
    const hhmm = (iso: string) =>
      new Date(iso).toLocaleTimeString("es-EC", { timeZone: this.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return `${fecha}: ocupado ${busy.map((b) => `${hhmm(b.start)}-${hhmm(b.end)}`).join(", ")}. Lo demás entre 08:00 y 19:00 está libre.`;
  }

  /** Crea la evaluación con recordatorio el día anterior y el mismo día. */
  async crearEvaluacion(inicioIso: string, titulo: string, descripcion: string): Promise<string> {
    const inicio = new Date(inicioIso);
    const fin = new Date(inicio.getTime() + 60 * 60_000);
    const ev = await this.api(`calendars/${encodeURIComponent(this.calendarId)}/events`, {
      method: "POST",
      body: {
        summary: titulo,
        description: descripcion,
        start: { dateTime: inicio.toISOString(), timeZone: this.tz },
        end: { dateTime: fin.toISOString(), timeZone: this.tz },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 24 * 60 },
            { method: "popup", minutes: 120 },
          ],
        },
      },
    });
    return ev.htmlLink ?? ev.id;
  }
}

/** Sin calendario configurado: el agente sabe que debe escalar. */
export class SinCalendario implements Calendario {
  async ocupado(fecha: string): Promise<string> {
    return `Calendario no conectado. No confirmes ${fecha}: pon paso "comprometido" y escala a Mario con categoria "pago" para que él confirme la hora.`;
  }
}
