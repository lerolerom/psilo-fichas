import { GoogleAuth, OAuth2Client } from "google-auth-library";
import type { Calendario } from "./agent/agente.js";
import { esFinDeSemana, partesLocales } from "./tiempo.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const D = 24 * 3600_000;

export interface EventoCreado {
  link: string; // enlace al evento en Google Calendar
  meet: string | null; // enlace de Google Meet si es en línea
}

/**
 * Calendario principal de Mario (manual, 24 nov 2026: "el calendario que cuenta es el principal").
 * Con OAuth de su cuenta se pueden crear links de Meet; con cuenta de servicio, no.
 */
export class GoogleCalendario implements Calendario {
  private request: (o: { url: string; method: "GET" | "POST"; data?: unknown; params?: Record<string, unknown> }) => Promise<any>;

  constructor(
    cred: { clientId?: string; clientSecret?: string; refreshToken?: string; serviceAccountJson?: string },
    private calendarId: string,
    private tz: string,
    private feriados: Set<string>,
    private horario: [number, number], // minutos desde medianoche, ej. [540, 1140]
  ) {
    if (cred.refreshToken && cred.clientId && cred.clientSecret) {
      const c = new OAuth2Client(cred.clientId, cred.clientSecret);
      c.setCredentials({ refresh_token: cred.refreshToken });
      this.request = async (o) => (await c.request(o)).data;
    } else if (cred.serviceAccountJson) {
      const auth = new GoogleAuth({ credentials: JSON.parse(cred.serviceAccountJson), scopes: SCOPES });
      this.request = async (o) => (await (await auth.getClient()).request(o)).data;
    } else {
      throw new Error("Calendario sin credenciales");
    }
  }

  private async ocupados(desde: Date, hasta: Date): Promise<{ start: Date; end: Date }[]> {
    const data = await this.request({
      url: "https://www.googleapis.com/calendar/v3/freeBusy",
      method: "POST",
      data: { timeMin: desde.toISOString(), timeMax: hasta.toISOString(), timeZone: this.tz, items: [{ id: this.calendarId }] },
    });
    const busy: { start: string; end: string }[] = data.calendars?.[this.calendarId]?.busy ?? [];
    return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  private hhmm(d: Date): string {
    return d.toLocaleTimeString("es-EC", { timeZone: this.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }

  async ocupado(fecha: string): Promise<string> {
    const ref = new Date(`${fecha}T12:00:00-05:00`);
    if (esFinDeSemana(ref, this.tz)) return `${fecha} es fin de semana: la evaluación es solo entre semana.`;
    if (this.feriados.has(fecha)) return `${fecha} es feriado: no se atiende.`;
    const [a, b] = this.horario;
    const ini = new Date(`${fecha}T${String(a / 60 | 0).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}:00-05:00`);
    const fin = new Date(`${fecha}T${String(b / 60 | 0).padStart(2, "0")}:${String(b % 60).padStart(2, "0")}:00-05:00`);
    const busy = await this.ocupados(ini, fin);
    if (!busy.length) return `${fecha}: libre todo el horario de evaluaciones.`;
    return `${fecha}: ocupado ${busy.map((x) => `${this.hhmm(x.start)}-${this.hhmm(x.end)}`).join(", ")}. El resto del horario está libre.`;
  }

  async libre(inicioIso: string, minutos: number): Promise<boolean> {
    const inicio = new Date(inicioIso);
    return (await this.ocupados(inicio, new Date(inicio.getTime() + minutos * 60_000))).length === 0;
  }

  /**
   * Próximos horarios libres cercanos al pedido: primero el mismo día, luego los días hábiles siguientes.
   * Devuelve hasta `max` opciones en saltos de 30 minutos dentro del horario de evaluaciones.
   */
  async huecosLibres(cercaDeIso: string, minutos: number, max = 3): Promise<string[]> {
    const pedido = new Date(cercaDeIso);
    const opciones: string[] = [];
    for (let i = 0; i < 8 && opciones.length < max; i++) {
      const dia = new Date(pedido.getTime() + i * D);
      const { fecha } = partesLocales(dia, this.tz);
      const ref = new Date(`${fecha}T12:00:00-05:00`);
      if (esFinDeSemana(ref, this.tz) || this.feriados.has(fecha)) continue;
      const [a, b] = this.horario;
      const ini = new Date(`${fecha}T${String(a / 60 | 0).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}:00-05:00`);
      const fin = new Date(`${fecha}T${String(b / 60 | 0).padStart(2, "0")}:${String(b % 60).padStart(2, "0")}:00-05:00`);
      const busy = await this.ocupados(ini, fin);
      // Mismo día: horarios más cercanos a la hora pedida; otros días, a la misma hora o cerca.
      const objetivo = partesLocales(pedido, this.tz);
      const candidatos: Date[] = [];
      for (let t = ini.getTime(); t + minutos * 60_000 <= fin.getTime(); t += 30 * 60_000) candidatos.push(new Date(t));
      const objetivoMin = objetivo.hora * 60 + objetivo.minuto;
      candidatos.sort((x, y) => {
        const mx = partesLocales(x, this.tz);
        const my = partesLocales(y, this.tz);
        return Math.abs(mx.hora * 60 + mx.minuto - objetivoMin) - Math.abs(my.hora * 60 + my.minuto - objetivoMin);
      });
      for (const c of candidatos) {
        const cFin = new Date(c.getTime() + minutos * 60_000);
        if (c.getTime() === pedido.getTime()) continue;
        if (c < new Date()) continue;
        if (busy.some((x) => c < x.end && cFin > x.start)) continue;
        const dl = c.toLocaleDateString("es-EC", { timeZone: this.tz, weekday: "long", day: "numeric", month: "long" });
        opciones.push(`${dl} a las ${this.hhmm(c)} (${fecha}T${this.hhmm(c)})`);
        break; // una opción por día: así se ofrecen días distintos
      }
    }
    return opciones;
  }

  /** "Sesión de evaluación con [nombre]"; si es en línea, con link de Meet. Recordatorios el día anterior y 1 h antes. */
  async crearEvaluacion(inicioIso: string, titulo: string, descripcion: string, minutos = 45, enLinea = false): Promise<EventoCreado> {
    const inicio = new Date(inicioIso);
    const fin = new Date(inicio.getTime() + minutos * 60_000);
    const ev = await this.request({
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`,
      method: "POST",
      params: enLinea ? { conferenceDataVersion: 1 } : undefined,
      data: {
        summary: titulo,
        description: descripcion,
        start: { dateTime: inicio.toISOString(), timeZone: this.tz },
        end: { dateTime: fin.toISOString(), timeZone: this.tz },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 24 * 60 }, { method: "popup", minutes: 60 }] },
        ...(enLinea
          ? { conferenceData: { createRequest: { requestId: `eval-${inicio.getTime()}-${Math.random().toString(36).slice(2, 8)}`, conferenceSolutionKey: { type: "hangoutsMeet" } } } }
          : {}),
      },
    });
    const meet = ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri ?? null;
    return { link: ev.htmlLink ?? ev.id, meet };
  }
}

/** Sin calendario configurado: el agente sabe que Mario revisa la hora. */
export class SinCalendario implements Calendario {
  async ocupado(fecha: string): Promise<string> {
    return `Calendario no conectado: no puedo ver la agenda del ${fecha}. Puedes usar enviar_datos_pago igual: Mario revisa la hora antes de confirmar.`;
  }
}
