/**
 * Revisión de cada mensaje ANTES de enviarlo. Son las reglas que la auditora del sistema anterior
 * detectaba después del envío (Correcciones y aprendizajes del Setter, 19 al 24 nov 2026).
 * Si algo falla, el mensaje no sale y el agente recibe el motivo para reescribirlo.
 */

export interface EstadoRevision {
  chatNuevo: boolean; // sin mensajes nuestros, de Mario, de Dani ni de Vero, y sin historial previo
  preguntasProfundizar: number;
  precioEvaluacionDado: boolean;
}

export interface Problema {
  grave: boolean; // identidad: si persiste, el turno se escala
  motivo: string;
}

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Palabras que nunca llegan a un lead (Mario, 21 nov 2026). */
export function violaIdentidad(texto: string): string | null {
  const t = sinTildes(texto);
  const reglas: [RegExp, string][] = [
    [/\bIA\b/, "IA"],
    [/inteligencia artificial/i, "inteligencia artificial"],
    [/\basistente/i, "asistente"],
    [/\bbots?\b/i, "bot"],
    [/automatic|automatizad/i, "automático"],
    [/\bclaude\b/i, "Claude"],
    [/\bchatgpt\b|\bmodelo de lenguaje\b/i, "modelo de lenguaje"],
  ];
  for (const [r, palabra] of reglas) if (r.test(t)) return palabra;
  return null;
}

const APERTURAS_PROHIBIDAS = [
  /^gracias por (contarmelo|contarme|compartirlo|compartir|abrirte|confiar)/i,
  /es normal que (de|te de) (algo de )?respeto/i,
];

export function revisarMensaje(texto: string, estado: EstadoRevision, opts: { profundizar: boolean }): Problema[] {
  const p: Problema[] = [];
  const t = texto.trim();
  const plano = sinTildes(t);

  const id = violaIdentidad(t);
  if (id) p.push({ grave: true, motivo: `Contiene "${id}". Regla absoluta: nunca digas ni insinúes que eres IA, asistente, bot o sistema automático. Preséntate como el dueño del chat.` });

  if (/[—–]/.test(t)) p.push({ grave: false, motivo: "Tiene raya larga. Usa coma, punto o reestructura la frase." });
  if (/\p{Extended_Pictographic}/u.test(t)) p.push({ grave: false, motivo: "Tiene emojis. Sin emojis." });
  if (/^\s*([-•*]|\d+[.)])\s+/m.test(t) && !/1\) el precio/.test(t)) p.push({ grave: false, motivo: "Tiene viñetas o lista. Escribe en frases cortas." });
  if (/(?<![\p{L}])(gu[ií]a|guiad[oa]s?|guiamos)(?![\p{L}])/iu.test(t)) p.push({ grave: false, motivo: 'Usa "acompañamiento" o "te acompañamos", nunca "guía".' });
  const palabra = (w: string, flags = "iu") => new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, flags);
  if (["acá", "vos", "contáme", "tenés", "querés"].some((w) => palabra(w).test(t)) || palabra("tomás", "u").test(t)) {
    p.push({ grave: false, motivo: 'Español latinoamericano neutro: "aquí", "tú", "tomas", "cuéntame".' });
  }
  for (const r of APERTURAS_PROHIBIDAS) {
    if (r.test(plano)) p.push({ grave: false, motivo: 'No abras con "Gracias por contármelo/compartirlo/abrirte" ni consuelos inventados. Entra directo con sus palabras.' });
  }
  const preguntas = (t.match(/¿/g) ?? []).length;
  if (preguntas > 1 && !/1\) el precio/.test(t)) p.push({ grave: false, motivo: "Tiene más de una pregunta. Una sola pregunta por mensaje." });

  // Precios fuera de orden (Mario, 20 nov 2026)
  if (/\$\s?790|\b790\b|\$\s?540|1[.,]?390|lunes a jueves|viernes a domingo|\bindividual\b|\bgrupal\b/i.test(t)) {
    p.push({ grave: false, motivo: 'No des "$790", "$540", "$1,390", "lunes a jueves", "individual" ni "grupal" salvo mucha insistencia; en ese caso escala con categoria precio_detalle.' });
  }
  if (estado.precioEvaluacionDado && /\$\s?490/.test(t) && /\$\s?40\b/.test(t)) {
    p.push({ grave: false, motivo: 'Ya se dio la evaluación de $40: ahora solo "La inversión del programa va desde $490.", sin repetir los $40.' });
  }
  if (/\b\d{9,}\b/.test(t.replace(/\s/g, "")) && /cuenta|ahorros|produbanco|transferencia/i.test(t)) {
    p.push({ grave: false, motivo: "No escribas datos bancarios: usa enviar_datos_pago." });
  }
  if (/calendar\.app\.google|calendly|agenda(r)? (tu|la) (cita|evaluaci[oó]n) aqu[ií]/i.test(plano)) {
    p.push({ grave: false, motivo: "Nunca envíes un link de agendamiento: la evaluación se agenda con el comprobante." });
  }

  // Primer mensaje solo a un chat realmente nuevo (Mario, 22 nov 2026 14:29)
  if (/gracias por escribirnos a despertar/i.test(plano) && !estado.chatNuevo) {
    p.push({ grave: false, motivo: "Este chat no es nuevo (ya hay mensajes nuestros, del equipo o historial previo). No uses la plantilla de primer mensaje: continúa la conversación." });
  }

  // Tope de profundizar (Mario, 22 nov 2026 09:51)
  if (opts.profundizar && estado.preguntasProfundizar >= 3) {
    p.push({ grave: false, motivo: "Ya van 3 preguntas de profundizar. Nunca una cuarta: el siguiente mensaje es el reflejo con sus palabras y, si nadie lo preguntó, \"¿Conoces la terapia asistida con psilocibina?\"." });
  }
  return p;
}
