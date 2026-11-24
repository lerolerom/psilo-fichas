import Anthropic from "@anthropic-ai/sdk";
import { MANUAL_SETTER } from "./manual.js";
import { CATEGORIAS, Entradas, HERRAMIENTAS, type NombreHerramienta } from "./herramientas.js";
import { revisarMensaje, type EstadoRevision } from "./revision.js";
import { ETAPAS, type Etapa, type Paso, type TIPOS_ENVIO } from "../db.js";

export interface MensajeSaliente {
  texto: string;
  tipo: (typeof TIPOS_ENVIO)[number];
  profundizar: boolean;
  reflejo: boolean;
}

/** Lo que el agente decidió en un turno. El motor lo ejecuta (o lo convierte en propuesta para Mario). */
export interface Decision {
  mensajes: MensajeSaliente[];
  escalacion: {
    categoria: (typeof CATEGORIAS)[number] | "identidad";
    motivo: string;
    propuesta: string;
    enviarTambien: boolean;
  } | null;
  etapa: Etapa | null;
  paso: Paso | null;
  datos: { campo: string; valor: string }[];
  datosPago: { fechaHora: string; modalidad: "en línea" | "presencial" } | null;
  comprobante: string | null;
  noResponder: string | null;
  rechazo: boolean; // el modelo se negó (stop_reason refusal)
}

export interface Calendario {
  ocupado(fecha: string): Promise<string>;
  libre?(inicioIso: string, minutos: number): Promise<boolean>;
  huecosLibres?(cercaDeIso: string, minutos: number, max?: number): Promise<string[]>;
}

/** Contenido para el agente: texto de la ficha + adjuntos recientes del lead (comprobantes). */
export interface EntradaAgente {
  texto: string;
  adjuntos: { mediaType: string; base64: string }[];
  estado: EstadoRevision;
}

const MAX_MENSAJES = 2;
const MAX_ITERACIONES = 10;
const MAX_REINTENTOS_IDENTIDAD = 2;

export function decisionVacia(): Decision {
  return {
    mensajes: [],
    escalacion: null,
    etapa: null,
    paso: null,
    datos: [],
    datosPago: null,
    comprobante: null,
    noResponder: null,
    rechazo: false,
  };
}

export class AgenteSetter {
  constructor(
    private client: Anthropic,
    private opts: { modelo: string; effort: "low" | "medium" | "high" | "xhigh" | "max" },
    private calendario: Calendario,
    private duracionEvaluacion = 45,
  ) {}

  async decidir(entrada: EntradaAgente): Promise<Decision> {
    const d = decisionVacia();
    const estado = { ...entrada.estado };
    let fallosIdentidad = 0;

    const contenido: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const a of entrada.adjuntos) {
      if (a.mediaType === "application/pdf") {
        contenido.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.base64 } });
      } else {
        contenido.push({
          type: "image",
          source: { type: "base64", media_type: a.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: a.base64 },
        });
      }
    }
    contenido.push({ type: "text", text: entrada.texto });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: contenido }];

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
        const out = await this.ejecutar(uso.name as NombreHerramienta, uso.input, d, estado);
        if (out.identidad) fallosIdentidad++;
        resultados.push({ type: "tool_result", tool_use_id: uso.id, content: out.texto, is_error: out.error });
      }
      messages.push({ role: "user", content: resultados });

      if (fallosIdentidad > MAX_REINTENTOS_IDENTIDAD) {
        // No logra escribir sin palabras prohibidas: no sale nada y lo ve Mario.
        d.mensajes = [];
        d.escalacion = {
          categoria: "identidad",
          motivo: "El agente no logró redactar la respuesta sin palabras prohibidas (IA, asistente, bot). No se envió nada.",
          propuesta: "",
          enviarTambien: false,
        };
        return d;
      }
      // Turno terminado de forma explícita: no hace falta otra vuelta al modelo.
      if (d.noResponder || (d.escalacion && !d.escalacion.enviarTambien) || d.comprobante) break;
    }
    return d;
  }

  private async ejecutar(
    nombre: NombreHerramienta,
    input: unknown,
    d: Decision,
    estado: EstadoRevision,
  ): Promise<{ texto: string; error?: boolean; identidad?: boolean }> {
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
        const problemas = revisarMensaje(v.texto, estado, { profundizar: v.profundizar });
        if (problemas.length) {
          return {
            texto: `No enviado. Corrige y vuelve a llamar a enviar_mensaje:\n- ${problemas.map((x) => x.motivo).join("\n- ")}`,
            error: true,
            identidad: problemas.some((x) => x.grave),
          };
        }
        d.mensajes.push({ texto: v.texto.trim(), tipo: v.tipo, profundizar: v.profundizar, reflejo: v.reflejo });
        if (v.profundizar) estado.preguntasProfundizar++;
        if (/\$\s?40\b/.test(v.texto)) estado.precioEvaluacionDado = true;
        estado.chatNuevo = false;
        return { texto: "Mensaje revisado y en cola para envío." };
      }
      case "escalar_a_mario": {
        const propuesta = v.propuesta.trim();
        if (propuesta) {
          const prob = revisarMensaje(propuesta, estado, { profundizar: false }).filter((x) => x.grave);
          if (prob.length) return { texto: `La propuesta rompe la regla de identidad: ${prob[0].motivo} Reescríbela.`, error: true, identidad: true };
        }
        d.escalacion = {
          categoria: v.categoria,
          motivo: v.motivo,
          propuesta,
          enviarTambien: v.enviar_tambien && v.categoria === "caliente",
        };
        return { texto: "Caso dejado a Mario. No envíes nada más en este turno salvo que sea 'caliente'." };
      }
      case "actualizar_etapa":
        if (v.etapa) d.etapa = v.etapa;
        if (v.paso) d.paso = v.paso;
        return { texto: "Etapa registrada." };
      case "registrar_dato":
        if (v.campo === "fecha_acordada" && !/^\d{4}-\d{2}-\d{2}$/.test(v.valor)) {
          return { texto: "fecha_acordada debe ser AAAA-MM-DD.", error: true };
        }
        d.datos.push({ campo: v.campo, valor: v.valor });
        return { texto: "Dato guardado." };
      case "consultar_disponibilidad":
        try {
          return { texto: await this.calendario.ocupado(v.fecha) };
        } catch (e) {
          return { texto: `No pude revisar el calendario (${(e as Error).message}). No confirmes la hora: escala con categoria "otro".`, error: true };
        }
      case "enviar_datos_pago": {
        const hora = Number(v.fecha_hora.slice(11, 13));
        const dia = new Date(`${v.fecha_hora.slice(0, 10)}T12:00:00-05:00`).getUTCDay();
        if (dia === 0 || dia === 6) return { texto: "Es fin de semana: la evaluación es solo entre semana. Pide otro día.", error: true };
        if (hora >= 19) return { texto: "Después de las 19:00 no se agenda: ofrece otra hora o escala si el lead insiste.", error: true };
        if (this.calendario.libre) {
          try {
            const ok = await this.calendario.libre(`${v.fecha_hora}:00-05:00`, this.duracionEvaluacion);
            if (!ok) {
              const huecos = this.calendario.huecosLibres
                ? await this.calendario.huecosLibres(`${v.fecha_hora}:00-05:00`, this.duracionEvaluacion).catch(() => [])
                : [];
              return {
                texto:
                  "Esa hora choca con otro evento del calendario de Mario. Dile que esa hora no está disponible y ofrécele otra libre" +
                  (huecos.length ? `. Horarios libres cercanos: ${huecos.join("; ")}. Ofrece uno o dos y pregunta cuál le queda mejor.` : "."),
                error: true,
              };
            }
          } catch (e) {
            return { texto: `No pude revisar el calendario (${(e as Error).message}). No confirmes: escala con categoria "otro".`, error: true };
          }
        }
        d.datosPago = { fechaHora: v.fecha_hora, modalidad: v.modalidad };
        return { texto: "Datos de pago y formulario en cola para envío. No escribas tú la cuenta." };
      }
      case "registrar_comprobante":
        d.comprobante = v.evidencia;
        return { texto: "Comprobante registrado: el sistema agenda, confirma y envía formulario y dirección si corresponde." };
      case "no_responder":
        d.noResponder = v.motivo;
        return { texto: "Entendido, no se envía nada." };
    }
  }
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
  // Agendó y Converted solo los pone el sistema (comprobante) o Mario.
  if (propuesta === "Agendo sesion Evaluacion" || propuesta === "Converted") return actual;
  return orden[propuesta] > orden[actual] || actual === "Lost" || actual === "Not qualified" ? propuesta : actual;
}

export { ETAPAS };
