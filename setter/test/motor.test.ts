import { describe, expect, it } from "vitest";
import { MARIO, decision, montar } from "./helpers.js";

const LEAD = "593991234567";
const MIN = 60_000;

describe("flujo de respuesta", () => {
  it("espera el debounce y luego responde con el agente", async () => {
    const t = montar({ decisiones: [decision({ mensajes: ["Hola, te saluda Mario de Despertar. ¿Cómo te llamas?"], paso: "abrio" })] });
    await t.entrante(LEAD, "hola, vi el anuncio", "w1");
    await t.motor.tick();
    expect(t.enviados).toHaveLength(0); // aún dentro del debounce
    t.avanzar(2 * MIN);
    await t.motor.tick();
    expect(t.enviados.map((e) => e.to)).toEqual([LEAD]);
    expect(t.contextos[0]).toContain("hola, vi el anuncio");
    const l = t.store.lead(LEAD)!;
    expect(l.pendiente_desde).toBeNull();
    expect(l.proximo_toque).not.toBeNull();
  });

  it("no lee ni contesta chats de Vero", async () => {
    const t = montar();
    t.store.crearLead(LEAD, { dueno: "VERO" });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(5 * MIN);
    await t.motor.tick();
    expect(t.contextos).toHaveLength(0);
    expect(t.enviados).toHaveLength(0);
  });

  it("si alguien del equipo escribe desde la app, el agente no duplica", async () => {
    const t = montar();
    await t.entrante(LEAD, "hola", "w1");
    await t.motor.procesar([{ tipo: "eco", para: LEAD, waId: "e1", ts: t.ahora, clase: "text", texto: "Hola, soy Mario" }]);
    t.avanzar(5 * MIN);
    await t.motor.tick();
    expect(t.contextos).toHaveLength(0);
    await t.entrante(LEAD, "gracias Mario", "w2");
    t.avanzar(5 * MIN);
    await t.motor.tick();
    expect(t.contextos).toHaveLength(0); // sigue en silencio humano
  });

  it("no responde fuera de horario y lo hace al abrir", async () => {
    const t = montar({ ahora: new Date("2026-11-25T03:00:00Z"), decisiones: [decision({ mensajes: ["Hola"] })] }); // 22:00 Quito
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(5 * MIN);
    await t.motor.tick();
    expect(t.enviados).toHaveLength(0);
    t.avanzar(10 * 60 * MIN); // 08:05
    await t.motor.tick();
    expect(t.enviados).toHaveLength(1);
  });

  it("ignora reintentos del mismo mensaje de Meta", async () => {
    const t = montar();
    await t.entrante(LEAD, "hola", "w1");
    await t.entrante(LEAD, "hola", "w1");
    expect(t.store.mensajes(LEAD)).toHaveLength(1);
  });
});

describe("riesgo", () => {
  it("riesgo alto: mensaje de contención fijo, pausa y alerta urgente, sin pasar por el agente", async () => {
    const t = montar();
    await t.entrante(LEAD, "la verdad ya no quiero vivir", "w1");
    expect(t.contextos).toHaveLength(0);
    const alLead = t.enviados.filter((e) => e.to === LEAD);
    expect(alLead).toHaveLength(1);
    expect(alLead[0].texto).toContain("171 opción 6");
    const aMario = t.enviados.filter((e) => e.to === MARIO);
    expect(aMario.some((e) => e.texto.includes("URGENTE"))).toBe(true);
    expect(t.store.lead(LEAD)!.pausado).toBe(1);
    t.avanzar(5 * MIN);
    await t.motor.tick();
    expect(t.contextos).toHaveLength(0);
  });

  it("riesgo en chat de Vero: solo alerta a fundadores, nada al lead", async () => {
    const t = montar();
    t.store.crearLead(LEAD, { dueno: "VERO" });
    await t.entrante(LEAD, "ya no quiero vivir", "w1");
    expect(t.enviados.filter((e) => e.to === LEAD)).toHaveLength(0);
    expect(t.enviados.filter((e) => e.to === MARIO)[0].texto).toContain("VERO");
  });

  it("riesgo ambiguo: no responde nada automático, solo alerta", async () => {
    const t = montar();
    await t.entrante(LEAD, "a veces quisiera desaparecer", "w1");
    expect(t.enviados.filter((e) => e.to === LEAD)).toHaveLength(0);
    expect(t.enviados.filter((e) => e.to === MARIO)).toHaveLength(1);
  });

  it("IGNORAR una escalación de riesgo no reanuda el chat", async () => {
    const t = montar();
    await t.entrante(LEAD, "pienso en suicidarme", "w1");
    const esc = t.store.escalacionesPendientes()[0];
    await t.motor.comandoAdmin(MARIO, `IGNORAR ${esc.id}`);
    expect(t.store.lead(LEAD)!.pausado).toBe(1);
  });
});

describe("escalación a Mario", () => {
  it("medicación: no envía nada al lead, pausa y manda propuesta; OK la envía", async () => {
    const propuesta = "Gracias por contarme. ¿Quién te receta la sertralina y desde cuándo la tomas?";
    const t = montar({
      decisiones: [decision({ escalacion: { categoria: "medicacion", motivo: "Toma sertralina", propuesta, enviarTambien: false }, mensajes: ["no debería salir"] })],
    });
    await t.entrante(LEAD, "tomo sertralina, ¿puedo hacerlo?", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    expect(t.enviados.filter((e) => e.to === LEAD)).toHaveLength(0);
    const nota = t.enviados.find((e) => e.to === MARIO)!;
    expect(nota.texto).toContain("MEDICACION");
    expect(t.store.lead(LEAD)!.pausado).toBe(1);

    const esc = t.store.escalacionesPendientes()[0];
    await t.motor.comandoAdmin(MARIO, `OK ${esc.id}`);
    expect(t.enviados.filter((e) => e.to === LEAD).map((e) => e.texto)).toEqual([propuesta]);
    expect(t.store.lead(LEAD)!.pausado).toBe(0);
  });

  it("EDITAR envía el texto de Mario", async () => {
    const t = montar({ decisiones: [decision({ escalacion: { categoria: "legal", motivo: "pregunta legalidad", propuesta: "x", enviarTambien: false } })] });
    await t.entrante(LEAD, "¿es legal?", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    const esc = t.store.escalacionesPendientes()[0];
    await t.motor.comandoAdmin(MARIO, `EDITAR ${esc.id} Te lo explico en una llamada. ¿Te parece mañana?`);
    expect(t.enviados.filter((e) => e.to === LEAD).at(-1)!.texto).toBe("Te lo explico en una llamada. ¿Te parece mañana?");
  });

  it("caliente: responde al lead y además avisa", async () => {
    const t = montar({
      decisiones: [decision({ mensajes: ["¿Qué día te queda mejor?"], escalacion: { categoria: "caliente", motivo: "urgente y con capacidad de pago", propuesta: "-", enviarTambien: true } })],
    });
    await t.entrante(LEAD, "necesito empezar ya, ¿cuándo puedo?", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    expect(t.enviados.filter((e) => e.to === LEAD)).toHaveLength(1);
    expect(t.enviados.filter((e) => e.to === MARIO)).toHaveLength(1);
    expect(t.store.lead(LEAD)!.pausado).toBe(0);
  });

  it("modo aprobación: nada sale sin OK de Mario", async () => {
    const t = montar({ cfg: { MODO: "aprobacion" }, decisiones: [decision({ mensajes: ["Hola, ¿cómo te llamas?"] })] });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    expect(t.enviados.filter((e) => e.to === LEAD)).toHaveLength(0);
    const esc = t.store.escalacionesPendientes()[0];
    expect(esc.categoria).toBe("aprobacion");
    await t.motor.comandoAdmin(MARIO, `OK ${esc.id}`);
    expect(t.enviados.filter((e) => e.to === LEAD)).toHaveLength(1);
  });
});

describe("seguimiento y plantillas", () => {
  it("lead de formulario: primer contacto con plantilla y luego seguimiento en día hábil", async () => {
    const t = montar();
    await t.motor.ingresarLead({ telefono: "0991234567", nombre: "Ana Pérez", formulario: "Ansiedad hace años", origen: "formulario", anuncio: null });
    await t.motor.tick();
    const p = t.enviados.find((e) => e.to === LEAD)!;
    expect(p.plantilla).toBe("primer_contacto_formulario");
    expect(p.texto).toBe("Ana|Mario|Ansiedad hace años");
    const l = t.store.lead(LEAD)!;
    expect(l.paso).toBe("contactado");
    // mismo día, 4 horas después
    expect(new Date(l.proximo_toque!).getTime() - t.ahora.getTime()).toBe(4 * 60 * MIN);
    t.avanzar(4 * 60 * MIN + MIN);
    await t.motor.tick();
    expect(t.enviados.filter((e) => e.to === LEAD).at(-1)!.plantilla).toBe("seguimiento_contactado_1");
  });

  it("formulario sin respuesta usa la plantilla correspondiente", async () => {
    const t = montar();
    await t.motor.ingresarLead({ telefono: LEAD, nombre: "Luis", formulario: "", origen: "formulario", anuncio: null });
    await t.motor.tick();
    expect(t.enviados[0].plantilla).toBe("primer_contacto_sin_respuesta");
  });

  it("chat de Dani sin presentación definida: escala en vez de escribir", async () => {
    const t = montar();
    await t.motor.ingresarLead({ telefono: LEAD, nombre: "Luis", formulario: "x", origen: "formulario", anuncio: null, dueno: "DANI" });
    await t.motor.tick();
    expect(t.enviados.filter((e) => e.to === LEAD)).toHaveLength(0);
    expect(t.store.escalacionesPendientes()[0].categoria).toBe("presentacion_dani");
  });

  it("fuera de la ventana de 24 h el seguimiento usa plantilla aprobada", async () => {
    const t = montar({ decisiones: [decision({ mensajes: ["¿Desde cuándo lo sientes?"], paso: "abrio" })] });
    await t.entrante(LEAD, "tengo ansiedad", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    t.avanzar(24 * 60 * MIN); // toque de "abrio": +1 día, ya fuera de la ventana
    await t.motor.tick();
    const ultimo = t.enviados.filter((e) => e.to === LEAD).at(-1)!;
    expect(ultimo.plantilla).toBe("seguimiento_conversando_1");
    expect(t.contextos).toHaveLength(1);
  });

  it("dentro de la ventana de 24 h el seguimiento lo redacta el agente", async () => {
    const t = montar({ decisiones: [decision({ mensajes: ["Gracias por contarme."], paso: "contactado" }), decision({ mensajes: ["¿Cómo te afecta en el trabajo?"] })] });
    await t.entrante(LEAD, "tengo ansiedad", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    t.avanzar(4 * 60 * MIN + MIN); // "contactado": mismo día, +4 h
    await t.motor.tick();
    expect(t.contextos).toHaveLength(2);
    expect(t.contextos[1]).toContain("MODO SEGUIMIENTO");
    expect(t.enviados.filter((e) => e.to === LEAD).at(-1)!.texto).toBe("¿Cómo te afecta en el trabajo?");
    expect(t.store.lead(LEAD)!.intentos_sin_respuesta).toBe(1);
  });

  it("abandonados no se contactan: se pregunta a Mario", async () => {
    const t = montar();
    await t.motor.ingresarLead({ telefono: LEAD, nombre: null, formulario: null, origen: "abandonado", anuncio: null });
    await t.motor.tick();
    expect(t.enviados.filter((e) => e.to === LEAD)).toHaveLength(0);
    expect(t.store.lead(LEAD)!.pausado).toBe(1);
  });

  it("nunca pisa un lead existente", async () => {
    const t = montar();
    t.store.crearLead(LEAD, { dueno: "VERO" });
    await t.motor.ingresarLead({ telefono: LEAD, nombre: "X", formulario: "y", origen: "formulario", anuncio: null });
    expect(t.store.lead(LEAD)!.dueno).toBe("VERO");
  });
});

describe("etapas", () => {
  it("el agente no baja etapas", async () => {
    const t = montar({ decisiones: [decision({ mensajes: ["ok"], etapa: "Intake" })] });
    t.store.crearLead(LEAD, { dueno: "MARIO" });
    t.store.actualizar(LEAD, { etapa: "Qualified" });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    expect(t.store.lead(LEAD)!.etapa).toBe("Qualified");
  });

  it("14 días sin respuesta: Intake -> Not qualified (si hubo más de un toque)", async () => {
    const t = montar();
    await t.motor.ingresarLead({ telefono: LEAD, nombre: "Ana", formulario: "x", origen: "formulario", anuncio: null });
    for (let i = 0; i < 30; i++) {
      t.avanzar(12 * 60 * MIN);
      await t.motor.tick();
    }
    expect(t.store.lead(LEAD)!.etapa).toBe("Not qualified");
  });

  it("comando PAGADO marca Agendó y corta el seguimiento", async () => {
    const t = montar();
    t.store.crearLead(LEAD, { dueno: "MARIO" });
    await t.motor.comandoAdmin(MARIO, "PAGADO 0991234567 2026-11-27 15:00");
    const l = t.store.lead(LEAD)!;
    expect(l.etapa).toBe("Agendo sesion Evaluacion");
    expect(l.proximo_toque).toBeNull();
  });

  it("comando DUEÑO reasigna y libera chats iniciados desde la app", async () => {
    const t = montar();
    await t.motor.procesar([{ tipo: "eco", para: LEAD, waId: "e1", ts: t.ahora, clase: "text", texto: "Hola" }]);
    expect(t.store.lead(LEAD)!.pausado).toBe(1);
    await t.motor.comandoAdmin(MARIO, "DUEÑO 0991234567 DANI");
    expect(t.store.lead(LEAD)!.dueno).toBe("DANI");
    expect(t.store.lead(LEAD)!.pausado).toBe(0);
  });
});
