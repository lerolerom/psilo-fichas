/** Casos encontrados en la revisión independiente del código (Fable, 24 nov 2026). */
import { describe, expect, it } from "vitest";
import { MARIO, MIN, decision, montar, msg } from "./helpers.js";
import { revisarMensaje } from "../src/agent/revision.js";
import type { AgenteSetter, EntradaAgente } from "../src/agent/agente.js";

const LEAD = "593991234567";

describe("revisión de Fable", () => {
  it("1. si falla el mensaje de contención, Mario igual recibe la alerta de riesgo", async () => {
    const t = montar();
    const wa = (t.motor as any).wa;
    const original = wa.enviarTexto;
    wa.enviarTexto = async (to: string, texto: string) => {
      if (to === LEAD) throw new Error("WhatsApp 500");
      return original(to, texto);
    };
    await t.entrante(LEAD, "ya no quiero vivir", "w1");
    expect(t.aMario()).toHaveLength(1);
    expect(t.aMario()[0].texto).toContain("NO se pudo enviar el mensaje de contención");
  });

  it("2. si el lead escribe mientras el agente decide, no queda sin respuesta", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("respuesta vieja")] }), decision({ mensajes: [msg("respuesta a todo")] })] });
    const agente = (t.motor as any).agente as AgenteSetter;
    const decidir = agente.decidir.bind(agente);
    let primera = true;
    agente.decidir = async (e: EntradaAgente) => {
      if (primera) {
        primera = false;
        await t.entrante(LEAD, "y otra cosa más", "w2"); // llega durante la decisión
      }
      return decidir(e);
    };
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(0); // la decisión vieja se descartó
    t.avanzar(2 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD).map((e) => e.texto)).toEqual(["respuesta a todo"]);
  });

  it("3. si Mario contesta desde la app mientras el agente decide, el lead no recibe dos respuestas", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("respuesta del agente")] })] });
    t.store.crearLead(LEAD, { dueno: "MARIO" });
    const agente = (t.motor as any).agente as AgenteSetter;
    const decidir = agente.decidir.bind(agente);
    agente.decidir = async (e: EntradaAgente) => {
      await t.eco(LEAD, "Hola, soy Mario", "e1");
      return decidir(e);
    };
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(0);
  });

  it("4. un seguimiento que no envía nada no se repite en cada ciclo", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("Hola")] })] });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    const toque = new Date(t.store.lead(LEAD)!.proximo_toque!);
    t.avanzar(toque.getTime() - t.ahora.getTime() + MIN);
    for (let i = 0; i < 5; i++) await t.motor.tick(); // las siguientes decisiones son "no responder"
    expect(t.entradas.length).toBeLessThanOrEqual(2);
  });

  it("5. OK fuera de la ventana de 24 h no finge que envió", async () => {
    const t = montar({ env: { SEGUIMIENTO_FUERA_DE_VENTANA: "plantillas" }, decisiones: [decision({ escalacion: { categoria: "legal", motivo: "¿es legal?", propuesta: "Te lo explico por llamada.", enviarTambien: false } })] });
    await t.entrante(LEAD, "¿es legal?", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    t.avanzar(30 * 60 * MIN);
    const esc = t.store.escalacionesPendientes()[0];
    const r = await t.motor.comandoAdmin(MARIO, `OK ${esc.id}`);
    expect(r).toContain("más de 24 h");
    expect(t.alLead(LEAD)).toHaveLength(0);
  });

  it("6. si el calendario falla al registrar el comprobante, el caso pasa a Mario", async () => {
    const t = montar({
      calendario: { async crearEvaluacion() { throw new Error("Google 503"); } },
      decisiones: [decision({ comprobante: "transferencia $40" })],
    });
    t.store.crearLead(LEAD, { dueno: "MARIO", nombre: "Ana" });
    t.store.actualizar(LEAD, { cita: "2026-11-26T20:00:00.000Z", modalidad: "en línea" });
    await t.entrante(LEAD, "ya pagué", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    const esc = t.store.escalacionesPendientes()[0];
    expect(esc.categoria).toBe("agendar");
    expect(esc.motivo).toContain("No se pudo crear el evento");
    // Mario lo crea a mano y aprueba: queda pagado y confirmado.
    await t.motor.comandoAdmin(MARIO, `OK ${esc.id}`);
    expect(t.store.lead(LEAD)!.pago_confirmado).toBe(1);
    expect(t.alLead(LEAD)[0].texto).toContain("quedó agendada");
  });

  it("9. OK envía la propuesta completa aunque tenga varios párrafos", async () => {
    const propuesta = "Párrafo uno.\n\nPárrafo dos.";
    const t = montar({ decisiones: [decision({ escalacion: { categoria: "clinica", motivo: "x", propuesta, enviarTambien: false } })] });
    await t.entrante(LEAD, "pregunta clínica", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    await t.motor.comandoAdmin(MARIO, `OK ${t.store.escalacionesPendientes()[0].id}`);
    expect(t.alLead(LEAD).map((e) => e.texto)).toEqual([propuesta]);
  });

  it("10. en modo aprobación la cuenta para el pago también espera el OK de Mario", async () => {
    const t = montar({ env: { MODO: "aprobacion" }, decisiones: [decision({ datosPago: { fechaHora: "2026-11-26T15:00", modalidad: "en línea" } })] });
    await t.entrante(LEAD, "el jueves a las 3", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(0);
    await t.motor.comandoAdmin(MARIO, `OK ${t.store.escalacionesPendientes()[0].id}`);
    expect(t.alLead(LEAD)[0].texto).toContain("La transferencia de los $40");
  });

  it("11. en modo sombra los comandos de Mario no envían nada al lead", async () => {
    const t = montar({ env: { MODO: "sombra" } });
    t.store.crearLead(LEAD, { dueno: "MARIO" });
    t.store.actualizar(LEAD, { cita: "2026-11-26T20:00:00.000Z", ultimo_in: t.ahora.toISOString() });
    await t.motor.comandoAdmin(MARIO, "PAGADO 0991234567");
    expect(t.alLead(LEAD)).toHaveLength(0);
  });

  it("14. no se ofrece la misma hora a dos leads, ni fuera del horario", async () => {
    const t = montar();
    t.store.crearLead("593980000000", { dueno: "MARIO" });
    t.store.actualizar("593980000000", { cita: "2026-11-26T20:00:00.000Z" });
    expect(t.motor.validarCita(LEAD, "2026-11-26T15:00")).toContain("reservada");
    expect(t.motor.validarCita(LEAD, "2026-11-26T18:30")).toContain("horario");
    expect(t.motor.validarCita(LEAD, "2026-11-28T10:00")).toContain("fin de semana");
    expect(t.motor.validarCita(LEAD, "2026-11-23T10:00")).toContain("pasó");
    expect(t.motor.validarCita(LEAD, "2026-11-26T16:00")).toBeNull();
  });

  it("13. si el agente no decide nada, el caso pasa a Mario", async () => {
    const t = montar({ decisiones: [decision({})] });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.store.escalacionesPendientes()[0].motivo).toContain("no logró decidir");
  });

  it("15. una reacción con emoji no se trata como mensaje", async () => {
    const t = montar();
    await t.motor.procesar(
      (await import("../src/whatsapp.js")).parsearWebhook({
        entry: [{ changes: [{ field: "messages", value: { messages: [{ from: LEAD, id: "r1", timestamp: "1764000000", type: "reaction", reaction: { emoji: "👍" } }] } }] }],
      }),
    );
    expect(t.store.lead(LEAD)).toBeUndefined();
  });

  it("19. detecta números de cuenta escritos a mano", () => {
    const r = revisarMensaje("La cuenta 2200123456 de ahorros", { chatNuevo: false, preguntasProfundizar: 0, precioEvaluacionDado: false }, { profundizar: false });
    expect(r.some((x) => x.motivo.includes("datos bancarios"))).toBe(true);
  });

  it("23. quien dijo que no y vuelve a escribir, retoma la conversación", async () => {
    const t = montar();
    t.store.crearLead(LEAD, { dueno: "MARIO" });
    t.store.actualizar(LEAD, { dijo_no: 1 });
    await t.entrante(LEAD, "hola, lo estuve pensando", "w1");
    expect(t.store.lead(LEAD)!.dijo_no).toBe(0);
  });
});
