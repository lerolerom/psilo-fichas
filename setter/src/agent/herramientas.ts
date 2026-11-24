import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ETAPAS, PASOS, TIPOS_ENVIO } from "../db.js";

export const CATEGORIAS = [
  "riesgo",
  "medicacion",
  "clinica",
  "fuera_de_quito",
  "familiar",
  "legal",
  "menor",
  "adiccion",
  "beca",
  "precio_detalle",
  "ya_hizo_proceso",
  "pregunta_identidad",
  "audio",
  "historial",
  "caliente",
  "reclamo",
  "otro",
] as const;

export const CAMPOS_DATO = [
  "nombre",
  "ciudad",
  "nota",
  "aprendizaje",
  "no_explicito",
  "fecha_acordada",
  "oferta_dani",
] as const;

const nullable = (t: string) => ({ type: [t, "null"] });

/** Definiciones para la API (strict: el modelo siempre manda entradas que validan contra el esquema). */
export const HERRAMIENTAS: Anthropic.Beta.BetaTool[] = [
  {
    name: "enviar_mensaje",
    description:
      "Envía un mensaje de texto al lead por WhatsApp. Máximo dos por turno. El sistema revisa identidad, estilo y precios; si te lo devuelve con un error, corrígelo y vuelve a llamar.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "Texto exacto a enviar." },
        tipo: { type: "string", enum: [...TIPOS_ENVIO], description: "Etiqueta de aprendizaje del manual." },
        profundizar: { type: "boolean", description: "true si es una pregunta de profundizar el dolor (cuenta para el tope de 3)." },
        reflejo: { type: "boolean", description: "true si es el mensaje de reflejo del paso 4." },
      },
      required: ["texto", "tipo", "profundizar", "reflejo"],
      additionalProperties: false,
    },
  },
  {
    name: "escalar_a_mario",
    description:
      "Deja el caso a Mario con una propuesta de respuesta lista para enviar. El chat queda en pausa hasta que Mario decida. No envíes mensajes en el mismo turno salvo enviar_tambien=true (solo 'caliente').",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        categoria: { type: "string", enum: [...CATEGORIAS] },
        motivo: { type: "string", description: "Una línea: qué dijo el lead y por qué lo decide Mario." },
        propuesta: { type: "string", description: "Respuesta propuesta para el lead, lista para enviar (vacío si no aplica)." },
        enviar_tambien: { type: "boolean" },
      },
      required: ["categoria", "motivo", "propuesta", "enviar_tambien"],
      additionalProperties: false,
    },
  },
  {
    name: "actualizar_etapa",
    description: "Actualiza la etapa (Meta/WhatsApp) y/o el paso de la conversación.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        etapa: { ...nullable("string"), enum: [...ETAPAS, null] },
        paso: { ...nullable("string"), enum: [...PASOS, null] },
        razon: { type: "string" },
      },
      required: ["etapa", "paso", "razon"],
      additionalProperties: false,
    },
  },
  {
    name: "registrar_dato",
    description:
      "Guarda un dato del lead. nombre/ciudad/nota: texto. no_explicito: el lead dijo que no a todo (sale del seguimiento). fecha_acordada: AAAA-MM-DD, no se le escribe antes. oferta_dani: ofrecida | aceptada | rechazada. aprendizaje: propuesta para el manual.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        campo: { type: "string", enum: [...CAMPOS_DATO] },
        valor: { type: "string" },
      },
      required: ["campo", "valor"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_disponibilidad",
    description:
      "Revisa el calendario principal de Mario para una fecha (macrodosis, sesiones, evaluaciones). Devuelve los bloques ocupados. Úsalo antes de aceptar o confirmar cualquier día y hora.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { fecha: { type: "string", description: "AAAA-MM-DD" } },
      required: ["fecha"],
      additionalProperties: false,
    },
  },
  {
    name: "enviar_datos_pago",
    description:
      "El lead eligió un día y hora libres: el sistema le envía la cuenta para la transferencia de $40 con el texto aprobado y el formulario previo, y guarda la cita. No escribas tú los datos bancarios.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        fecha_hora: { type: "string", description: "AAAA-MM-DDTHH:MM, hora de Quito" },
        modalidad: { type: "string", enum: ["en línea", "presencial"] },
      },
      required: ["fecha_hora", "modalidad"],
      additionalProperties: false,
    },
  },
  {
    name: "registrar_comprobante",
    description:
      "El lead envió el comprobante de la transferencia de $40 para la cita ya acordada: el sistema crea la evaluación en el calendario, la confirma al lead, pide el formulario y envía la dirección si es presencial. Solo si ves el comprobante (imagen o PDF) o un aviso inequívoco de pago.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { evidencia: { type: "string", description: "Qué viste: monto, banco, fecha." } },
      required: ["evidencia"],
      additionalProperties: false,
    },
  },
  {
    name: "no_responder",
    description: "No enviar nada en este turno (por ejemplo, el lead solo agradeció un cierre).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string" } },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
];

export const Entradas = {
  enviar_mensaje: z.object({
    texto: z.string().min(1).max(1500),
    tipo: z.enum(TIPOS_ENVIO),
    profundizar: z.boolean(),
    reflejo: z.boolean(),
  }),
  escalar_a_mario: z.object({
    categoria: z.enum(CATEGORIAS),
    motivo: z.string(),
    propuesta: z.string(),
    enviar_tambien: z.boolean(),
  }),
  actualizar_etapa: z.object({
    etapa: z.enum(ETAPAS).nullable(),
    paso: z.enum(PASOS).nullable(),
    razon: z.string(),
  }),
  registrar_dato: z.object({ campo: z.enum(CAMPOS_DATO), valor: z.string() }),
  consultar_disponibilidad: z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  enviar_datos_pago: z.object({
    fecha_hora: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    modalidad: z.enum(["en línea", "presencial"]),
  }),
  registrar_comprobante: z.object({ evidencia: z.string() }),
  no_responder: z.object({ motivo: z.string() }),
} as const;

export type NombreHerramienta = keyof typeof Entradas;
