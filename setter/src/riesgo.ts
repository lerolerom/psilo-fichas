/**
 * Detección determinista de riesgo. Corre ANTES del agente y no depende del modelo.
 * Manual: cualquier mención de no querer estar aquí, de huir o de hacerse daño pasa de inmediato
 * a los fundadores, sin venta. En crisis no se vende: se acompaña y se redirige (171 opción 6 o 911).
 *
 * - "alto": señales explícitas de suicidio o autolesión -> mensaje de contención fijo + alerta urgente.
 * - "medio": señales ambiguas ("huir", "desaparecer") -> no se responde nada automático, alerta a fundadores.
 */
export type NivelRiesgo = "alto" | "medio" | null;

const sinTildes = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const ALTO: RegExp[] = [
  /suicid/,
  /quitarme la vida/,
  /\bmatarme\b/,
  /\bme quiero morir\b/,
  /\bquiero morir(me)?\b/,
  /ganas de morir/,
  /no quiero (seguir )?vivir/,
  /no quiero estar aqui/,
  /no quiero seguir (aqui|en este mundo)/,
  /acabar con (todo|mi vida)/,
  /hacerme dano/,
  /lastimarme/,
  /\bcortarme\b/,
  /mejor (estaria )?muert[oa]/,
  /no (le )?veo sentido a (la|mi) vida/,
];

const MEDIO: RegExp[] = [
  /\bhuir\b/,
  /\bdesaparecer\b/,
  /ya no (aguanto|puedo) mas/,
  /no quiero despertar/,
  /\bme hago dano\b/,
];

export function detectarRiesgo(texto: string): NivelRiesgo {
  const t = sinTildes(texto);
  if (ALTO.some((r) => r.test(t))) return "alto";
  if (MEDIO.some((r) => r.test(t))) return "medio";
  return null;
}

export function mensajeContencion(nombre: string | null): string {
  const n = nombre ? `, ${nombre.split(" ")[0]}` : "";
  return (
    `Gracias por contármelo${n}. Lo que estás sintiendo importa y no tienes que pasarlo a solas. ` +
    `Si sientes que estás en peligro ahora, llama al 171 opción 6 o al 911. ` +
    `Uno de los fundadores te va a escribir personalmente en un momento. ¿Estás en un lugar seguro ahora?`
  );
}
