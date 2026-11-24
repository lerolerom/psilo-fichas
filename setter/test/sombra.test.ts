import { describe, expect, it } from "vitest";
import { MARIO, MIN, decision, montar, msg } from "./helpers.js";
import { MetaConversiones } from "../src/meta.js";

const LEAD = "593991234567";

describe("modo sombra", () => {
  it("el agente decide pero no envía nada; la comparación muestra lo que se envió de verdad", async () => {
    const t = montar({ env: { MODO: "sombra" }, decisiones: [decision({ mensajes: [msg("Dices que te sientes sola. ¿Cómo se siente eso en tu día a día?")] })] });
    await t.entrante(LEAD, "me siento muy sola desde que me separé", "w1");
    t.avanzar(30_000);
    await t.eco(LEAD, "Lamento lo que estás viviendo. ¿Hace cuánto te separaste?", "e1"); // la ronda de Chrome contestó
    t.avanzar(2 * MIN);
    await t.motor.tick();
    expect(t.enviados).toHaveLength(0);
    expect(t.entradas).toHaveLength(1);
    // El agente no vio la respuesta de la ronda: propone a ciegas, para comparar de verdad.
    expect(t.entradas[0].texto).not.toContain("Hace cuánto te separaste");
    const filas = t.motor.comparacionSombra(new Date(t.ahora.getTime() - 60 * MIN), new Date(t.ahora.getTime() + MIN));
    expect(filas).toHaveLength(1);
    expect(filas[0].lead).toEqual(["me siento muy sola desde que me separé"]);
    expect(filas[0].propuesta[0]).toContain("Cómo se siente eso");
    expect(filas[0].real[0].texto).toContain("Hace cuánto te separaste");
  });

  it("riesgo en sombra: no envía nada, queda registrado lo que habría hecho", async () => {
    const t = montar({ env: { MODO: "sombra" } });
    await t.entrante(LEAD, "ya no quiero vivir", "w1");
    expect(t.enviados).toHaveLength(0);
    const filas = t.motor.comparacionSombra(new Date(t.ahora.getTime() - MIN), new Date(t.ahora.getTime() + MIN));
    expect(filas[0].modo).toBe("riesgo");
    expect(filas[0].propuesta[0]).toContain("171 opción 6");
  });

  it("el reporte diario en sombra trae el resumen y el enlace al panel", async () => {
    const t = montar({ env: { MODO: "sombra", URL_PUBLICA: "https://setter.ejemplo" }, decisiones: [decision({ mensajes: [msg("Hola")] })] });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    t.avanzar(24 * 60 * MIN);
    const r = t.motor.reporteDiario(t.ahora);
    expect(r).toContain("Modo sombra");
    expect(r).toContain("https://setter.ejemplo/panel/sombra?fecha=2026-11-24&token=t");
  });
});

describe("seguimientos fuera de la ventana para las rondas de Chrome", () => {
  it("el agente redacta el seguimiento y queda en la lista del día, sin enviarse por la API", async () => {
    const t = montar({
      env: { SEGUIMIENTO_FUERA_DE_VENTANA: "chrome" },
      decisiones: [
        decision({ mensajes: [msg("¿Cómo te afecta eso en tu día a día?")], paso: "abrio" }),
        decision({ mensajes: [msg("Ana, me quedé pensando en lo que me contaste del trabajo. ¿Eso sigue ahí hoy?", { tipo: "reconexión" })] }),
      ],
    });
    await t.entrante(LEAD, "tengo ansiedad por el trabajo", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.enviados).toHaveLength(1);
    t.avanzar(3 * 24 * 60 * MIN); // viernes, fuera de las 24 h
    for (let i = 0; i < 4 * 24; i++) {
      t.avanzar(15 * MIN);
      await t.motor.tick();
      if (t.entradas.length >= 2) break;
    }
    expect(t.enviados).toHaveLength(1); // nada nuevo por la API
    const fecha = new Date(t.ahora.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
    const lista = t.store.listaChrome(fecha);
    expect(lista).toHaveLength(1);
    expect(lista[0].propuesta).toContain("me quedé pensando");
    // Cuando la ronda lo envía desde WhatsApp Web, llega como eco y se marca enviado.
    await t.eco(LEAD, lista[0].propuesta, "e1");
    expect(t.store.listaChrome(fecha)[0].estado).toBe("enviado");
  });
});

describe("Meta aprende de las etapas (API de Conversiones)", () => {
  it("cada cambio de etapa se envía a Meta", async () => {
    const enviados: [string, string][] = [];
    const t = montar({
      conversiones: { enviar: async (lead: any, etapa: string) => (enviados.push([lead.telefono, etapa]), "enviado") },
      decisiones: [decision({ mensajes: [msg("La evaluación cuesta $40. ¿Qué día te queda mejor?")], etapa: "Qualified" })],
    });
    await t.entrante(LEAD, "¿cuánto cuesta?", "w1", "text", undefined, { source_type: "ad", ctwa_clid: "ARAkLkA8rmlFeiCktEJQ" });
    expect(t.store.lead(LEAD)!.ctwa_clid).toBe("ARAkLkA8rmlFeiCktEJQ");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(enviados).toEqual([[LEAD, "Qualified"]]);
  });

  it("en modo sombra no se envían etapas a Meta", async () => {
    const enviados: string[] = [];
    const t = montar({ env: { MODO: "sombra" }, conversiones: { enviar: async (_l: any, e: string) => (enviados.push(e), "enviado") } });
    t.store.crearLead(LEAD, { dueno: "MARIO" });
    t.store.actualizar(LEAD, { etapa: "Qualified" });
    await t.motor.tick();
    expect(enviados).toEqual([]);
  });

  it("arma el evento de CRM (formulario) y el de mensajería (anuncio a WhatsApp)", () => {
    const m = new MetaConversiones({ datasetId: "1", token: "x", wabaId: "999", version: "v23.0", nombreCrm: "Despertar Setter", eventosWhatsapp: "Qualified:QualifiedLead" });
    const base: any = { telefono: LEAD, leadgen_id: null, ctwa_clid: null };
    const ts = new Date("2026-11-24T15:00:00Z");
    expect(m.evento({ ...base, leadgen_id: "1234567890123456" }, "Qualified", ts)).toMatchObject({
      event_name: "Qualified",
      action_source: "system_generated",
      custom_data: { event_source: "crm", lead_event_source: "Despertar Setter" },
      user_data: { lead_id: "1234567890123456" },
    });
    expect(m.evento({ ...base, ctwa_clid: "abc" }, "Qualified", ts)).toMatchObject({
      event_name: "QualifiedLead",
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: { whatsapp_business_account_id: "999", ctwa_clid: "abc" },
    });
    expect(m.evento({ ...base, ctwa_clid: "abc" }, "Lost", ts)).toBeNull();
    expect(m.evento(base, "Qualified", ts)).toBeNull();
  });
});

void MARIO;
