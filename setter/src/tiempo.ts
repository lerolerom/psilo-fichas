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
 * Cadencia (manual, sección 7, y decisión de Mario del 24 nov 2026):
 * un mensaje por lead por día hábil, siempre con algo nuevo; si lleva más de una semana sin responder,
 * cada 3 días. Solo de lunes a viernes (sin feriados), alternando la franja de la mañana y la de la tarde
 * y a una hora distinta cada vez, para que no parezca automático.
 */
export function esperaSeguimiento(diasSinRespuesta: number): number {
  return diasSinRespuesta >= 7 ? 3 * D : 1 * D;
}

export type Azar = () => number; // 0..1

const pad = (n: number) => String(n).padStart(2, "0");

export function proximoToque(
  ultimoOut: Date,
  diasSinRespuesta: number,
  intentos: number,
  o: { tz: string; feriados: Set<string>; franjas: [number, number][]; azar: Azar; fechaAcordada?: string | null },
): Date {
  // Se cuenta por días de calendario: el toque cae N días después, en la franja que toca, a una hora al azar.
  const dias = Math.round(esperaSeguimiento(diasSinRespuesta) / D);
  let base = new Date(ultimoOut.getTime() + dias * D);
  if (o.fechaAcordada) {
    const acordada = new Date(`${o.fechaAcordada}T12:00:00-05:00`);
    if (acordada > base) base = acordada;
  }
  const franjas = o.franjas.length ? o.franjas : [[9 * 60, 18 * 60] as [number, number]];
  const franja = franjas[intentos % franjas.length];
  for (let i = 0; i < 21; i++) {
    const { fecha } = partesLocales(new Date(base.getTime() + i * D), o.tz);
    const ref = new Date(`${fecha}T12:00:00-05:00`);
    if (esFinDeSemana(ref, o.tz) || o.feriados.has(fecha)) continue;
    const minuto = franja[0] + Math.floor(o.azar() * Math.max(1, franja[1] - franja[0]));
    const t = new Date(`${fecha}T${pad(Math.floor(minuto / 60))}:${pad(minuto % 60)}:00-05:00`);
    if (t > ultimoOut) return t;
  }
  return new Date(base.getTime() + D);
}

/** ¿Es un momento válido para un seguimiento? (lunes a viernes sin feriados, dentro de alguna franja) */
export function enFranjaSeguimiento(d: Date, o: { tz: string; feriados: Set<string>; franjas: [number, number][] }): boolean {
  const p = partesLocales(d, o.tz);
  if (esFinDeSemana(d, o.tz) || o.feriados.has(p.fecha)) return false;
  const m = p.hora * 60 + p.minuto;
  return o.franjas.some(([a, b]) => m >= a && m < b);
}

/** Tiempo de "lectura" antes de contestar: al azar entre min y max, un poco más si el mensaje es largo. */
export function esperaLectura(largoTexto: number, o: { min: number; max: number; azar: Azar }): number {
  const extra = Math.min(2, largoTexto / 300); // hasta 2 minutos más por mensajes largos
  const minutos = Math.min(o.max, o.min + o.azar() * (o.max - o.min) * 0.8 + extra);
  return Math.round(minutos * 60_000);
}

/** Segundos que tomaría escribir un texto en el celular (para el indicador "escribiendo..."). */
export function tiempoEscritura(texto: string, azar: Azar): number {
  return Math.min(25_000, 3_000 + texto.length * 45 + azar() * 3_000);
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
