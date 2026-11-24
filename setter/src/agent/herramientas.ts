import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ETAPAS, PASOS } from "../db.js";

export const CATEGORIAS = [
  "riesgo",
  "medicacion",
  "clinica",
  "beca",
  "fuera_de_quito",
  "familiar",
  "legal",
  "menor",
  "adiccion",
  "caliente",
  "pago",
  "precio_completo",
  "presentacion_dani",
  "audio_o_medio",
  "otro",
] as const;

const nullable = (t: string) => ({ type: [t, "null"] });

/** Definiciones para la API (strict: el modelo siempre manda entradas que validan contra el esquema). */
export const HERRAMIENTAS: Anthropic.Beta.BetaTool[] = [
  {
    name: "enviar_mensaje",
    description:
      "Envía un mensaje de texto al lead por WhatsApp. Máximo dos por turno. Escribe con el estilo del manual: corto, sin emojis, sin viñetas, cierra con una pregunta o una línea breve.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { texto: { type: "string", description: "Texto exacto a enviar." } },
      required: ["texto"],
      additionalProperties: false,
    },
  },
  {
    name: "enviar_video_educativo",
    description:
      "Envía el video educativo sobre terapia asistida con psilocibina. Úsalo solo al pasar de Connect a Educado y solo si la ficha dice que no se envió antes.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "escalar_a_mario",
    description:
      "Pasa el caso a Mario con una propuesta de respuesta lista para enviar. Pausa el chat hasta que Mario decida. No envíes mensajes al lead en el mismo turno salvo enviar_tambien=true (solo para categoria 'caliente' o para preguntar si está en Quito).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        categoria: { type: "string", enum: [...CATEGORIAS] },
        motivo: { type: "string", description: "Una línea con el motivo." },
        propuesta: { type: "string", description: "Respuesta propuesta para el lead, lista para enviar." },
        enviar_tambien: {
          type: "boolean",
          description: "true si además envías tus mensajes de este turno al lead (solo 'caliente').",
        },
      },
      required: ["categoria", "motivo", "propuesta", "enviar_tambien"],
      additionalProperties: false,
    },
  },
  {
    name: "actualizar_etapa",
    description: "Actualiza la etapa de Meta y/o el paso de la conversación. Nunca bajes una etapa.",
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
    name: "guardar_dato",
    description: "Guarda un dato del lead (nombre, ciudad, nota) o un aprendizaje para el manual.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        campo: { type: "string", enum: ["nombre", "ciudad", "nota", "aprendizaje"] },
        valor: { type: "string" },
      },
      required: ["campo", "valor"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_disponibilidad",
    description:
      "Revisa el calendario de evaluaciones para una fecha (entre semana, hasta las 19:00, hora de Ecuador). Devuelve los bloques ocupados.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { fecha: { type: "string", description: "YYYY-MM-DD" } },
      required: ["fecha"],
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
  enviar_mensaje: z.object({ texto: z.string().min(1).max(1500) }),
  enviar_video_educativo: z.object({}).passthrough(),
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
  guardar_dato: z.object({ campo: z.enum(["nombre", "ciudad", "nota", "aprendizaje"]), valor: z.string() }),
  consultar_disponibilidad: z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  no_responder: z.object({ motivo: z.string() }),
} as const;

export type NombreHerramienta = keyof typeof Entradas;
