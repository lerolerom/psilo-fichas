import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { detectarRiesgo } from "../src/riesgo.js";
import { normalizarTelefono } from "../src/config.js";
import { esperaSeguimiento, proximoToque, siguienteMomentoPermitido } from "../src/tiempo.js";
import { firmaValida, parsearWebhook } from "../src/whatsapp.js";
import { etapaFinal, limpiarEstilo } from "../src/agent/agente.js";
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
  it("cadencia del manual", () => {
    const D = 86400_000;
    expect(esperaSeguimiento("ofrecido", 0)).toBe(D);
    expect(esperaSeguimiento("ofrecido", 2)).toBe(5 * D);
    expect(esperaSeguimiento("educado", 1)).toBe(3 * D);
    expect(esperaSeguimiento("contactado", 4)).toBe(30 * D);
    expect(esperaSeguimiento("agendado", 0)).toBeNull();
    expect(proximoToque("cerrado", 0, new Date(), h)).toBeNull();
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

describe("estilo y etapas", () => {
  it("quita la raya larga", () => {
    expect(limpiarEstilo("Hola — ¿cómo estás?")).toBe("Hola, ¿cómo estás?");
  });
  it("no baja etapas", () => {
    expect(etapaFinal("Qualified", "Intake")).toBe("Qualified");
    expect(etapaFinal("Intake", "Qualified")).toBe("Qualified");
    expect(etapaFinal("Qualified", "Lost")).toBe("Lost");
    expect(etapaFinal("Converted", "Lost")).toBe("Converted");
    expect(etapaFinal("Lost", "Qualified")).toBe("Qualified");
  });
  it("temperatura y contexto", () => {
    const m = (direccion: "in" | "out", tipo = "text") => ({ id: 1, telefono: "1", direccion, tipo, texto: "x", wa_id: null, autor: null, ts: new Date().toISOString() });
    expect(temperatura([m("in")])).toBe("frio");
    expect(temperatura([m("in"), m("in")])).toBe("tibio");
    expect(temperatura([m("in", "audio")])).toBe("caliente");
    const ctx = armarContexto(
      { telefono: "13055551234", nombre: null, dueno: "MARIO", etapa: "Intake", paso: "nuevo", origen: "directo", formulario: null, anuncio: null, ciudad: null, pausado: 0, motivo_pausa: null, humano_hasta: null, ultimo_in: null, ultimo_out: null, pendiente_desde: null, intentos_sin_respuesta: 0, proximo_toque: null, video_enviado: 0, horario_ofrecido: 0, notas: null, creado: new Date().toISOString() },
      [m("in", "audio")],
      { modo: "respuesta", ahora: new Date(), tz: "America/Guayaquil", presentacion: "Mario" },
    );
    expect(ctx).toContain("NO es número de Ecuador");
    expect(ctx).toContain("[audio: x]");
  });
});
