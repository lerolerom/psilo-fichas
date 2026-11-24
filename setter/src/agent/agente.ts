import Anthropic from "@anthropic-ai/sdk";
import { MANUAL_SETTER } from "./manual.js";
import { CATEGORIAS, Entradas, HERRAMIENTAS, type NombreHerramienta } from "./herramientas.js";
import { ETAPAS, type Etapa, type Paso } from "../db.js";

/** Lo que el agente decidió en un turno. El motor lo ejecuta (o lo convierte en propuesta). */
export interface Decision {
  mensajes: string[];
  enviarVideo: boolean;
  escalacion: {
    categoria: (typeof CATEGORIAS)[number];
    motivo: string;
    propuesta: string;
    enviarTambien: boolean;
  } | null;
  etapa: Etapa | null;
  paso: Paso | null;
  datos: { campo: string; valor: string }[];
  noResponder: string | null;
  rechazo: boolean; // el modelo se negó (stop_reason refusal)
}

export interface Calendario {
  ocupado(fecha: string): Promise<string>;
}

const MAX_MENSAJES = 2;
const MAX_ITERACIONES = 8;

export class AgenteSetter {
  constructor(
    private client: Anthropic,
    private opts: { modelo: string; effort: "low" | "medium" | "high" | "xhigh" | "max" },
    private calendario: Calendario,
  ) {}

  /** contexto = ficha del lead + conversación, ya formateados. */
  async decidir(contexto: string): Promise<Decision> {
    const d: Decision = {
      mensajes: [],
      enviarVideo: false,
      escalacion: null,
      etapa: null,
      paso: null,
      datos: [],
      noResponder: null,
      rechazo: false,
    };

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: contexto }];

    for (let i = 0; i < MAX_ITERACIONES; i++) {
      const res = await this.client.beta.messages.create({
        model: this.opts.modelo,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.opts.effort },
        system: [{ type: "text", text: MANUAL_SETTER, cache_control: { type: "ephemeral" } }],
        tools: HERRAMIENTAS,
        messages,
      });

      if (res.stop_reason === "refusal") {
        d.rechazo = true;
        return d;
      }
      if (res.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: res.content });
        continue;
      }

      const usos = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (usos.length === 0 || res.stop_reason !== "tool_use") break;

      messages.push({ role: "assistant", content: res.content });
      const resultados: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const uso of usos) {
        const out = await this.ejecutar(uso.name as NombreHerramienta, uso.input, d);
        resultados.push({ type: "tool_result", tool_use_id: uso.id, content: out.texto, is_error: out.error });
      }
      messages.push({ role: "user", content: resultados });

      // Turno terminado de forma explícita: no hace falta otra vuelta al modelo.
      if (d.noResponder || (d.escalacion && !d.escalacion.enviarTambien)) break;
    }
    return d;
  }

  private async ejecutar(
    nombre: NombreHerramienta,
    input: unknown,
    d: Decision,
  ): Promise<{ texto: string; error?: boolean }> {
    const esquema = Entradas[nombre];
    if (!esquema) return { texto: `Herramienta desconocida: ${nombre}`, error: true };
    const p = esquema.safeParse(input);
    if (!p.success) return { texto: `Entrada inválida: ${p.error.message}`, error: true };
    const v: any = p.data;

    switch (nombre) {
      case "enviar_mensaje": {
        if (d.mensajes.length >= MAX_MENSAJES) {
          return { texto: "No enviado: máximo dos mensajes seguidos. Espera la respuesta del lead.", error: true };
        }
        const texto = limpiarEstilo(v.texto);
        d.mensajes.push(texto);
        return { texto: "Mensaje en cola para envío." };
      }
      case "enviar_video_educativo":
        d.enviarVideo = true;
        return { texto: "Video en cola para envío." };
      case "escalar_a_mario":
        d.escalacion = {
          categoria: v.categoria,
          motivo: v.motivo,
          propuesta: limpiarEstilo(v.propuesta),
          enviarTambien: v.enviar_tambien && (v.categoria === "caliente" || v.categoria === "fuera_de_quito"),
        };
        return { texto: "Escalado a Mario. No envíes nada más en este turno salvo que enviar_tambien sea true." };
      case "actualizar_etapa":
        if (v.etapa) d.etapa = v.etapa;
        if (v.paso) d.paso = v.paso;
        return { texto: "Etapa registrada." };
      case "guardar_dato":
        d.datos.push({ campo: v.campo, valor: v.valor });
        return { texto: "Dato guardado." };
      case "consultar_disponibilidad":
        try {
          return { texto: await this.calendario.ocupado(v.fecha) };
        } catch (e) {
          return { texto: `No pude revisar el calendario (${(e as Error).message}). Escala a Mario con categoria "pago".`, error: true };
        }
      case "no_responder":
        d.noResponder = v.motivo;
        return { texto: "Entendido, no se envía nada." };
    }
  }
}

/** Red de seguridad de estilo: el manual prohíbe la raya larga. */
export function limpiarEstilo(t: string): string {
  return t.replace(/\s*—\s*/g, ", ").replace(/–/g, "-").trim();
}

/** Nunca bajar de etapa (Lost/Not qualified sí pueden reemplazar a Intake/Qualified). */
export function etapaFinal(actual: Etapa, propuesta: Etapa | null): Etapa {
  if (!propuesta || propuesta === actual) return actual;
  const orden: Record<Etapa, number> = {
    Intake: 0,
    Qualified: 1,
    "Agendo sesion Evaluacion": 2,
    Converted: 3,
    Lost: 1,
    "Not qualified": 0,
  };
  if (propuesta === "Lost" || propuesta === "Not qualified") {
    // No se pierde a alguien que ya pagó la evaluación o el programa por decisión del agente.
    return actual === "Converted" || actual === "Agendo sesion Evaluacion" ? actual : propuesta;
  }
  return orden[propuesta] > orden[actual] || actual === "Lost" || actual === "Not qualified" ? propuesta : actual;
}

export { ETAPAS };
