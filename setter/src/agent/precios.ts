/**
 * Precios por millón de tokens (USD), tarifa estándar de la API de Claude (nov 2026).
 * La caché del manual dura 1 hora: escribirla cuesta 2 veces la entrada; leerla, una décima parte.
 * Verificar en platform.claude.com/pricing si cambian.
 */
export interface Precio {
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura1h: number;
}

const p = (entrada: number, salida: number, cacheLectura = entrada / 10): Precio => ({
  entrada,
  salida,
  cacheLectura,
  cacheEscritura1h: entrada * 2,
});

export const PRECIOS: Record<string, Precio> = {
  "claude-haiku-5-5": p(0.1, 0.5),
  "claude-sonnet-5-5": p(2, 10, 0.1),
  "claude-sonnet-5": p(2, 10),
  "claude-opus-5-5": p(4, 20, 0.2),
  "claude-opus-5": p(5, 25),
  "claude-opus-4-8": p(5, 25),
};

export interface Uso {
  modelo: string;
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
  usd: number;
}

export function costo(modelo: string, u: { entrada: number; salida: number; cacheLectura: number; cacheEscritura: number }): number {
  const pr = PRECIOS[modelo] ?? PRECIOS["claude-opus-5"];
  return (u.entrada * pr.entrada + u.salida * pr.salida + u.cacheLectura * pr.cacheLectura + u.cacheEscritura * pr.cacheEscritura1h) / 1_000_000;
}

/** Modelos con fallback del lado del servidor ante un rechazo (Haiku 5.5 no lo tiene). */
export function aceptaFallback(modelo: string): boolean {
  return /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5)/.test(modelo);
}
