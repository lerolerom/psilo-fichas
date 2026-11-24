import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { detectarRiesgo } from "../src/riesgo.js";
import { normalizarTelefono } from "../src/config.js";
import { esperaLectura, esperaSeguimiento, proximoToque, siguienteMomentoPermitido, partesLocales } from "../src/tiempo.js";
import { revisarMensaje, violaIdentidad } from "../src/agent/revision.js";
import { firmaValida, parsearWebhook } from "../src/whatsapp.js";
import { etapaFinal } from "../src/agent/agente.js";
import { armarContexto, temperatura } from "../src/contexto.js";

const h = { tz: "America/Guayaquil", horaInicio: 8, horaFin: 21, feriados: new Set(["2026-12-25"]) };

describe("riesgo", () => {
  it.each([
    ["Ya no quiero vivir", "alto"],
    ["he pensado en el suicidio", "alto"],
    ["a veces quiero hacerme daño", "alto"],
    ["No quiero estar aquí", "alto"],
    ["quisiera huir de todo", "medio"],
    ["tengo ansiedad y no duermo", null],
    ["quiero vivir mejor", null],
  ])("%s -> %s", (t, n) => expect(detectarRiesgo(t)).toBe(n));
});

describe("teléfonos", () => {
  it("normaliza a 593 sin el 0", () => {
    expect(normalizarTelefono("099 123 4567")).toBe("593991234567");
    expect(normalizarTelefono("+593 99 123 4567")).toBe("593991234567");
    expect(normalizarTelefono("5930991234567")).toBe("593991234567");
    expect(normalizarTelefono("+1 (305) 555-1234")).toBe("13055551234");
  });
});

describe("tiempo", () => {
  it("salta fines de semana y feriados para los toques", () => {
    // sábado 28 nov 2026 10:00 Quito
    const t = siguienteMomentoPermitido(new Date("2026-11-28T15:00:00Z"), h, true);
    expect(t.toISOString()).toBe("2026-11-30T13:00:00.000Z"); // lunes 08:00
    const f = siguienteMomentoPermitido(new Date("2026-12-25T15:00:00Z"), h, true);
    expect(f.toISOString()).toBe("2026-12-28T13:00:00.000Z");
  });
  it("cadencia: diaria; cada 3 días tras una semana de silencio", () => {
    const D = 86400_000;
    expect(esperaSeguimiento(2)).toBe(D);
    expect(esperaSeguimiento(8)).toBe(3 * D);
  });
  it("seguimiento: salta fin de semana y alterna mañana y tarde", () => {
    const o = { tz: "America/Guayaquil", feriados: new Set<string>(), franjas: [[540, 720], [900, 1110]] as [number, number][], azar: () => 0.5 };
    const viernes = new Date("2026-11-27T15:00:00Z");
    const t0 = proximoToque(viernes, 0, 0, o);
    const p0 = partesLocales(t0, o.tz);
    expect(p0.diaSemana).toBe("Mon");
    expect(p0.hora).toBeLessThan(12);
    const t1 = proximoToque(viernes, 0, 1, o);
    expect(partesLocales(t1, o.tz).hora).toBeGreaterThanOrEqual(15);
  });
  it("lectura entre 3 y 10 minutos", () => {
    for (const azar of [0, 0.5, 0.99]) {
      const ms = esperaLectura(50, { min: 3, max: 10, azar: () => azar });
      expect(ms).toBeGreaterThanOrEqual(3 * 60_000);
      expect(ms).toBeLessThanOrEqual(10 * 60_000);
    }
  });
});

describe("revisión antes de enviar (errores reales de la bitácora)", () => {
  const nuevo = { chatNuevo: true, preguntasProfundizar: 0, precioEvaluacionDado: false };
  const enCurso = { ...nuevo, chatNuevo: false };
  it("identidad: 'asistente de IA' no sale nunca", () => {
    expect(violaIdentidad("Soy la asistente de IA del equipo de Mario Freire")).toBeTruthy();
    expect(violaIdentidad("Te saluda Mario")).toBeNull();
    expect(violaIdentidad("Hola, ¿cómo estás?")).toBeNull();
    expect(violaIdentidad("Es un botón")).toBeNull();
  });
  it("aperturas prohibidas, raya larga, dos preguntas", () => {
    expect(revisarMensaje("Gracias por contármelo, Camila. ¿Desde hace cuánto?", enCurso, { profundizar: false }).length).toBeGreaterThan(0);
    expect(revisarMensaje("Hola — ¿cómo estás?", enCurso, { profundizar: false }).length).toBeGreaterThan(0);
    expect(revisarMensaje("¿Cómo estás? ¿Qué te pasa?", enCurso, { profundizar: false }).length).toBeGreaterThan(0);
    expect(revisarMensaje("Dices que te sientes sola. ¿Cómo se siente eso en tu día a día?", enCurso, { profundizar: true })).toEqual([]);
  });
  it("precios fuera de orden", () => {
    expect(revisarMensaje("La sesión de fin de semana es de $790.", enCurso, { profundizar: false }).length).toBeGreaterThan(0);
    expect(revisarMensaje("En el proceso individual el acompañamiento es para ti sola.", enCurso, { profundizar: false }).length).toBeGreaterThan(0);
    expect(revisarMensaje("La inversión va desde $490 y la evaluación es de $40.", { ...enCurso, precioEvaluacionDado: true }, { profundizar: false }).length).toBeGreaterThan(0);
    expect(revisarMensaje("La inversión del programa va desde $490.", { ...enCurso, precioEvaluacionDado: true }, { profundizar: false })).toEqual([]);
  });
  it("primer mensaje solo a chat nuevo (caso +593 99 504 9713)", () => {
    const plantilla = "Hola Rocío, gracias por escribirnos a Despertar. Te saluda Mario.";
    expect(revisarMensaje(plantilla, nuevo, { profundizar: false })).toEqual([]);
    expect(revisarMensaje(plantilla, enCurso, { profundizar: false }).length).toBeGreaterThan(0);
  });
  it("nunca una cuarta pregunta de profundizar (caso Camila)", () => {
    expect(revisarMensaje("¿Qué has hecho para enfrentarlo?", { ...enCurso, preguntasProfundizar: 3 }, { profundizar: true }).length).toBeGreaterThan(0);
  });
});

describe("webhook", () => {
  it("valida la firma", () => {
    const body = Buffer.from('{"a":1}');
    const sig = "sha256=" + crypto.createHmac("sha256", "s").update(body).digest("hex");
    expect(firmaValida(body, sig, "s")).toBe(true);
    expect(firmaValida(body, "sha256=00", "s")).toBe(false);
  });
  it("parsea entrantes, ecos y estados", () => {
    const ev = parsearWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                contacts: [{ wa_id: "593991234567", profile: { name: "Ana" } }],
                messages: [{ from: "593991234567", id: "m1", timestamp: "1764000000", type: "text", text: { body: "hola" } }],
                statuses: [{ id: "s1", status: "failed", recipient_id: "593991234567", errors: [{ code: 131047, title: "Re-engagement" }] }],
              },
            },
            {
              field: "smb_message_echoes",
              value: { message_echoes: [{ from: "593200000000", to: "593991234567", id: "e1", timestamp: "1764000001", type: "text", text: { body: "Soy Mario" } }] },
            },
          ],
        },
      ],
    });
    expect(ev.map((e) => e.tipo)).toEqual(["entrante", "estado", "eco"]);
    expect(ev[0]).toMatchObject({ de: "593991234567", nombrePerfil: "Ana", texto: "hola" });
    expect(ev[2]).toMatchObject({ para: "593991234567", texto: "Soy Mario" });
  });
});

describe("etapas", () => {
  it("no baja etapas", () => {
    expect(etapaFinal("Qualified", "Intake")).toBe("Qualified");
    expect(etapaFinal("Intake", "Qualified")).toBe("Qualified");
    expect(etapaFinal("Qualified", "Lost")).toBe("Lost");
    expect(etapaFinal("Converted", "Lost")).toBe("Converted");
    expect(etapaFinal("Lost", "Qualified")).toBe("Qualified");
    expect(etapaFinal("Qualified", "Agendo sesion Evaluacion")).toBe("Qualified");
  });
  it("temperatura y contexto", () => {
    const m = (direccion: "in" | "out", tipo = "text") => ({ id: 1, telefono: "1", direccion, tipo, texto: "x", wa_id: null, autor: null, ts: new Date().toISOString() });
    expect(temperatura([m("in")])).toBe("frio");
    expect(temperatura([m("in"), m("in")])).toBe("tibio");
    expect(temperatura([m("in", "audio")])).toBe("caliente");
    const ctx = armarContexto(
      { telefono: "13055551234", nombre: null, dueno: "MARIO", etapa: "Intake", paso: "nuevo", origen: "directo", formulario: null, anuncio: null, ciudad: null, pausado: 0, motivo_pausa: null, humano_hasta: null, ultimo_in: null, ultimo_out: null, pendiente_desde: null, intentos_sin_respuesta: 0, proximo_toque: null, video_enviado: 0, horario_ofrecido: 0, notas: null, creado: new Date().toISOString(), preguntas_profundizar: 0, reflejo_enviado: 0, pregunto_conoce_terapia: 0, precio_evaluacion_dado: 0, precio_programa_dado: 0, datos_pago_enviados: 0, cita: null, modalidad: null, pago_confirmado: 0, recordatorio_cita: null, dijo_no: 0, oferta_dani: 0, historial_incompleto: 0, fecha_acordada: null, responder_despues: null, leadgen_id: null, ctwa_clid: null },
      [m("in", "audio")],
      { modo: "respuesta", ahora: new Date(), tz: "America/Guayaquil", material: { presentacion: "Mario", videoUrl: "v", testimoniosUrl: "t", telefonoDaniela: "d" } },
    );
    expect(ctx).toContain("NO es número de Ecuador");
    expect(ctx).toContain("[audio, transcripción] x");
  });
});
