import { describe, expect, it } from "vitest";
import { MARIO, MIN, decision, montar, msg } from "./helpers.js";
import { costo } from "../src/agent/precios.js";

const LEAD = "593991234567";

describe("inteligencia escalonada", () => {
  it("lo rutinario lo decide Haiku", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("¿Cómo se siente eso en tu día a día?")] })] });
    await t.entrante(LEAD, "hola, me siento muy cansada", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.modelos).toEqual(["claude-haiku-5-5"]);
  });

  it("el precio, las objeciones y los comprobantes empiezan en Sonnet", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("La evaluación cuesta $40. ¿Qué día te queda mejor?")] })] });
    await t.entrante(LEAD, "¿cuánto cuesta?", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.modelos).toEqual(["claude-sonnet-5-5"]);
  });

  it("si Haiku pide ayuda, decide Sonnet; si Sonnet no logra un mensaje válido, decide Opus 5", async () => {
    const t = montar({
      decisiones: [
        decision({ subir: "el lead mezcla duelo y dudas de precio" }),
        decision({ fallosRevision: 2 }),
        decision({ mensajes: [msg("Dices que desde que murió tu papá todo pesa más. ¿Qué es lo que más te pesa hoy?")] }),
      ],
    });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.modelos).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5"]);
    expect(t.alLead(LEAD)).toHaveLength(1);
  });

  it("al llegar al presupuesto del mes solo usa Haiku y avisa a Mario una vez", async () => {
    const t = montar({
      env: { PRESUPUESTO_MENSUAL_USD: "1" },
      decisiones: [decision({ mensajes: [msg("La evaluación cuesta $40. ¿Qué día te queda mejor?")] }), decision({ mensajes: [msg("ok")] })],
    });
    t.store.registrarCosto({ ts: t.ahora.toISOString(), telefono: null, modelo: "claude-sonnet-5-5", motivo: "prueba", entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 0, usd: 1.5 });
    await t.entrante(LEAD, "¿cuánto cuesta?", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.modelos).toEqual(["claude-haiku-5-5"]);
    expect(t.aMario().filter((m) => m.texto.includes("presupuesto del mes"))).toHaveLength(1);
  });

  it("el reporte diario trae el costo de ayer y del mes", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("Hola")] })] });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    t.avanzar(24 * 60 * MIN);
    const r = t.motor.reporteDiario(t.ahora);
    expect(r).toContain("Claude ayer: USD 0.01");
    expect(r).toContain("haiku-5-5 1 turnos");
  });

  it("precios: Haiku cuesta mucho menos que Opus por el mismo turno", () => {
    const u = { entrada: 4000, salida: 1000, cacheLectura: 8000, cacheEscritura: 0 };
    expect(costo("claude-haiku-5-5", u)).toBeLessThan(0.001);
    expect(costo("claude-opus-5", u)).toBeGreaterThan(0.04);
  });
});

void MARIO;
