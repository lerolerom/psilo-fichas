import type { Paso } from "./db.js";

export interface Horario {
  tz: string;
  horaInicio: number; // 8 -> desde las 08:00
  horaFin: number; // 21 -> hasta las 20:59
  feriados: Set<string>; // YYYY-MM-DD
}

const H = 3600_000;
const D = 24 * H;

/** Partes de fecha en la zona horaria del negocio. */
export function partesLocales(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    hora: Number(p.hour),
    minuto: Number(p.minute),
    diaSemana: p.weekday as string, // Mon..Sun
  };
}

export function esDiaHabil(d: Date, h: Horario): boolean {
  const p = partesLocales(d, h.tz);
  return p.diaSemana !== "Sat" && p.diaSemana !== "Sun" && !h.feriados.has(p.fecha);
}

export function dentroDeHorario(d: Date, h: Horario): boolean {
  const { hora } = partesLocales(d, h.tz);
  return hora >= h.horaInicio && hora < h.horaFin;
}

/** Siguiente momento permitido para escribir (avanza de a 15 minutos; simple y sin sorpresas de zona horaria). */
export function siguienteMomentoPermitido(desde: Date, h: Horario, soloDiaHabil: boolean): Date {
  let t = new Date(desde.getTime());
  for (let i = 0; i < 4 * 24 * 15; i++) {
    if (dentroDeHorario(t, h) && (!soloDiaHabil || esDiaHabil(t, h))) return t;
    t = new Date(t.getTime() + 15 * 60_000);
  }
  return t;
}

/**
 * Ventana de seguimiento del manual v2 (la etapa define qué se manda; el tiempo, cuándo).
 * Devuelve la espera desde el último mensaje nuestro, según cuántos toques sin respuesta van.
 * Después de cuatro intentos sin respuesta: ritmo mensual.
 */
export function esperaSeguimiento(paso: Paso, intentos: number): number | null {
  if (intentos >= 4) return 30 * D;
  switch (paso) {
    case "contactado":
      // mismo día, día 2, día 4, día 8 (acumulado desde el primer contacto)
      return [4 * H, 2 * D - 4 * H, 2 * D, 4 * D][intentos];
    case "abrio":
    case "conectado":
    case "educado":
      return [1 * D, 3 * D, 3 * D, 3 * D][intentos];
    case "ofrecido":
      return [1 * D, 2 * D, 5 * D, 5 * D][intentos];
    case "comprometido":
      // mismo día; luego Mario sigue el pago y la cita
      return intentos === 0 ? 4 * H : null;
    default:
      return null; // nuevo, agendado, cerrado: sin seguimiento automático
  }
}

export function proximoToque(
  paso: Paso,
  intentos: number,
  ultimoOut: Date,
  h: Horario,
): Date | null {
  const espera = esperaSeguimiento(paso, intentos);
  if (espera == null) return null;
  return siguienteMomentoPermitido(new Date(ultimoOut.getTime() + espera), h, true);
}

/** ¿Seguimos dentro de la ventana de atención de 24 h desde el último mensaje del lead? */
export function ventanaAbierta(ultimoIn: string | null, ahora: Date, margenMin = 10): boolean {
  if (!ultimoIn) return false;
  return ahora.getTime() - new Date(ultimoIn).getTime() < D - margenMin * 60_000;
}

export const DIA = D;
export const HORA = H;
