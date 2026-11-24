export interface Horario {
  tz: string;
  horaInicio: number; // respuestas: desde
  horaFin: number; // respuestas: hasta (exclusivo)
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

export function minutosDelDia(d: Date, tz: string): number {
  const p = partesLocales(d, tz);
  return p.hora * 60 + p.minuto;
}

export function esFinDeSemana(d: Date, tz: string): boolean {
  const w = partesLocales(d, tz).diaSemana;
  return w === "Sat" || w === "Sun";
}

export function esDiaHabil(d: Date, h: Horario): boolean {
  return !esFinDeSemana(d, h.tz) && !h.feriados.has(partesLocales(d, h.tz).fecha);
}

export function enRango(d: Date, tz: string, r: [number, number] | null): boolean {
  if (!r) return false;
  const m = minutosDelDia(d, tz);
  return m >= r[0] && m < r[1];
}

export function dentroDeHorario(d: Date, h: Horario): boolean {
  const { hora } = partesLocales(d, h.tz);
  return hora >= h.horaInicio && hora < h.horaFin;
}

/** Siguiente momento dentro de [horaInicio, horaFin) (avanza de a 15 minutos). */
export function siguienteMomentoPermitido(desde: Date, h: Horario, soloDiaHabil: boolean): Date {
  let t = new Date(desde.getTime());
  for (let i = 0; i < 4 * 24 * 15; i++) {
    if (dentroDeHorario(t, h) && (!soloDiaHabil || esDiaHabil(t, h))) return t;
    t = new Date(t.getTime() + 15 * 60_000);
  }
  return t;
}

/**
 * Cadencia del manual vigente (sección 7 y decisiones del 19 y 23 nov 2026):
 * un mensaje por lead por día, siempre con algo nuevo; si el lead lleva más de una semana sin responder,
 * cada 2 o 3 días (aquí: 3). Sigue en Intake, Qualified, Not qualified y Lost hasta un no explícito.
 * Los plazos de 14 y 21 días solo cambian la etapa.
 */
export function esperaSeguimiento(diasSinRespuesta: number): number {
  return diasSinRespuesta >= 7 ? 3 * D : 1 * D;
}

export function proximoToque(ultimoOut: Date, diasSinRespuesta: number, hSeguimiento: Horario, fechaAcordada?: string | null): Date {
  let t = new Date(ultimoOut.getTime() + esperaSeguimiento(diasSinRespuesta));
  if (fechaAcordada) {
    const acordada = new Date(`${fechaAcordada}T08:00:00-05:00`);
    if (acordada > t) t = acordada;
  }
  return siguienteMomentoPermitido(t, hSeguimiento, false);
}

/** ¿Seguimos dentro de la ventana de atención de 24 h desde el último mensaje del lead? */
export function ventanaAbierta(ultimoIn: string | null, ahora: Date, margenMin = 10): boolean {
  if (!ultimoIn) return false;
  return ahora.getTime() - new Date(ultimoIn).getTime() < D - margenMin * 60_000;
}

export function diasDesde(iso: string | null, ahora: Date): number {
  if (!iso) return 0;
  return Math.floor((ahora.getTime() - new Date(iso).getTime()) / D);
}

/** "2026-11-27T15:00" (hora de Quito) -> Date. Ecuador no tiene horario de verano. */
export function desdeLocal(fechaHora: string): Date {
  return new Date(`${fechaHora}:00-05:00`);
}

export function formatoCita(iso: string, tz: string): string {
  const d = new Date(iso);
  const dia = d.toLocaleDateString("es-EC", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
  const hora = d.toLocaleTimeString("es-EC", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${dia} a las ${hora}`;
}

export const DIA = D;
export const HORA = H;
