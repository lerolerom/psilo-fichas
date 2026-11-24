import { describe, expect, it } from "vitest";
import { MARIO, MIN, decision, montar, msg } from "./helpers.js";
import { partesLocales } from "../src/tiempo.js";

const LEAD = "593991234567";
const HORA = 60 * MIN;

describe("respuesta con tiempo de lectura", () => {
  it("no contesta al instante: espera entre 3 y 10 minutos y muestra 'escribiendo...'", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("Hola, te saluda Mario de Despertar. ¿Cómo te llamas?", { tipo: "primer mensaje" })] })] });
    await t.entrante(LEAD, "hola, vi el anuncio", "w1");
    t.avanzar(2 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(0);
    t.avanzar(9 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(1);
    expect(t.escribiendo).toContain("w1");
    expect(t.entradas[0].texto).toContain("hola, vi el anuncio");
  });

  it("contesta también de noche (con lectura)", async () => {
    const t = montar({ ahora: new Date("2026-11-25T08:00:00Z"), decisiones: [decision({ mensajes: [msg("Hola")] })] }); // 03:00 Quito
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(1);
  });

  it("si el lead escribe en ráfaga, contesta una sola vez a todo", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("Entiendo. ¿Cómo se siente eso en tu día a día?")] })] });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(2 * MIN);
    await t.entrante(LEAD, "tengo ansiedad", "w2");
    t.avanzar(9 * MIN);
    await t.motor.tick();
    expect(t.entradas).toHaveLength(1);
    expect(t.entradas[0].texto).toContain("tengo ansiedad");
  });

  it("no lee ni contesta chats de Vero", async () => {
    const t = montar();
    t.store.crearLead(LEAD, { dueno: "VERO" });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(15 * MIN);
    await t.motor.tick();
    expect(t.entradas).toHaveLength(0);
  });

  it("ignora reintentos del mismo mensaje de Meta", async () => {
    const t = montar();
    await t.entrante(LEAD, "hola", "w1");
    await t.entrante(LEAD, "hola", "w1");
    expect(t.store.mensajes(LEAD)).toHaveLength(1);
  });
});

describe("Mario escribe desde la app", () => {
  it("lo pendiente queda atendido por Mario y el agente sigue desde el siguiente mensaje del lead, leyendo lo que Mario dijo", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("Perfecto. ¿Qué día te queda mejor?")] })] });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(1 * MIN);
    await t.eco(LEAD, "Hola, soy Mario. Te puedo llamar mañana si prefieres.", "e1");
    t.avanzar(15 * MIN);
    await t.motor.tick();
    expect(t.entradas).toHaveLength(0); // Mario ya contestó

    t.avanzar(60 * MIN);
    await t.entrante(LEAD, "sí, mejor una llamada", "w2");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.entradas).toHaveLength(1);
    expect(t.entradas[0].texto).toContain("DESPERTAR (equipo, desde la app): Hola, soy Mario");
  });

  it("si el lead contesta enseguida a Mario, se le da margen a Mario antes de que conteste el agente", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("ok")] })], env: { LECTURA_MIN_MINUTOS: "1", LECTURA_MAX_MINUTOS: "2" } });
    await t.eco(LEAD, "Hola, soy Mario", "e1");
    t.store.actualizar(LEAD, { pausado: 0, motivo_pausa: null });
    await t.entrante(LEAD, "hola Mario", "w1");
    t.avanzar(3 * MIN);
    await t.motor.tick();
    expect(t.entradas).toHaveLength(0); // dentro de los 10 minutos de margen
    t.avanzar(8 * MIN);
    await t.motor.tick();
    expect(t.entradas).toHaveLength(1);
  });
});

describe("audios", () => {
  it("se transcriben y el agente los responde como texto", async () => {
    const t = montar({ transcripcion: "tengo mucha ansiedad en el trabajo", decisiones: [decision({ mensajes: [msg("¿Cómo te afecta eso en tu día a día?")] })] });
    await t.entrante(LEAD, "", "w1", "audio", "m1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.entradas[0].texto).toContain("[audio, transcripción] tengo mucha ansiedad en el trabajo");
    expect(t.alLead(LEAD)).toHaveLength(1);
  });

  it("la detección de riesgo también corre sobre el audio transcrito", async () => {
    const t = montar({ transcripcion: "a veces tengo ganas de morir" });
    await t.entrante(LEAD, "", "w1", "audio", "m1");
    expect(t.alLead(LEAD)[0].texto).toContain("171 opción 6");
    expect(t.aMario()[0].texto).toContain("audio transcrito");
  });
});

describe("riesgo (casos de Nat y Adriana)", () => {
  it("riesgo explícito: contención inmediata, sin lectura, pausa y alerta urgente", async () => {
    const t = montar();
    await t.entrante(LEAD, "Las ganas de morirme", "w1");
    expect(t.alLead(LEAD)).toHaveLength(1);
    expect(t.alLead(LEAD)[0].texto).toContain("171 opción 6");
    expect(t.aMario()[0].texto).toContain("URGENTE");
    expect(t.store.lead(LEAD)!.pausado).toBe(1);
  });

  it("si un caso de riesgo vuelve a escribir, Mario se entera de inmediato", async () => {
    const t = montar();
    await t.entrante(LEAD, "pienso en suicidarme", "w1");
    t.avanzar(HORA);
    await t.entrante(LEAD, "hola", "w2");
    expect(t.aMario().at(-1)!.texto).toContain("volvió a escribir");
  });

  it("IGNORAR una escalación de riesgo no reanuda el chat", async () => {
    const t = montar();
    await t.entrante(LEAD, "pienso en suicidarme", "w1");
    const esc = t.store.escalacionesPendientes()[0];
    await t.motor.comandoAdmin(MARIO, `IGNORAR ${esc.id}`);
    expect(t.store.lead(LEAD)!.pausado).toBe(1);
  });
});

describe("escalación y política de avisos", () => {
  it("medicación: no se envía nada, no se avisa al instante, aparece en el reporte diario; OK la envía", async () => {
    const propuesta = "¿Quién te prescribe esa medicación y desde cuándo la tomas?";
    const t = montar({ decisiones: [decision({ escalacion: { categoria: "medicacion", motivo: "Toma sertralina", propuesta, enviarTambien: false } })] });
    await t.entrante(LEAD, "tomo sertralina, ¿puedo hacerlo?", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(0);
    expect(t.aMario()).toHaveLength(0); // no es grave: va al reporte
    const reporte = t.motor.reporteDiario(t.ahora);
    expect(reporte).toContain("MEDICACION");
    expect(reporte).toContain(propuesta);
    const esc = t.store.escalacionesPendientes()[0];
    await t.motor.comandoAdmin(MARIO, `OK ${esc.id}`);
    expect(t.alLead(LEAD).map((e) => e.texto)).toEqual([propuesta]);
    expect(t.store.lead(LEAD)!.pausado).toBe(0);
  });

  it("el reporte diario sale una vez al día a las 07:50", async () => {
    const t = montar({ ahora: new Date("2026-11-25T12:40:00Z"), env: { HORA_REPORTE_DIARIO: "07:50" } }); // 07:40 Quito
    await t.motor.tick();
    expect(t.aMario()).toHaveLength(0);
    t.avanzar(11 * MIN);
    await t.motor.tick();
    await t.motor.tick();
    expect(t.aMario()).toHaveLength(1);
    expect(t.aMario()[0].texto).toContain("Reporte diario");
  });

  it("caliente: responde al lead y además avisa a Mario", async () => {
    const t = montar({
      decisiones: [decision({ mensajes: [msg("¿Qué día te queda mejor?")], escalacion: { categoria: "caliente", motivo: "urgente", propuesta: "", enviarTambien: true } })],
    });
    await t.entrante(LEAD, "necesito empezar ya", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(1);
    expect(t.aMario()).toHaveLength(1);
  });
});

describe("pago y agenda", () => {
  it("con hora libre envía la cuenta con el texto aprobado y el formulario", async () => {
    const t = montar({ decisiones: [decision({ datosPago: { fechaHora: "2026-11-26T15:00", modalidad: "en línea" } })] });
    await t.entrante(LEAD, "el jueves a las 3", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    const a = t.alLead(LEAD);
    expect(a[0].texto).toMatch(/^Excelente\. La transferencia de los \$40 por favor a esta cuenta:\nPRODUBANCO/);
    expect(a[0].texto).toContain("Cuando la hagas, me envías el comprobante");
    expect(a[1].texto).toContain("forms.gle");
    const l = t.store.lead(LEAD)!;
    expect(l.paso).toBe("comprometido");
    expect(l.cita).toBe("2026-11-26T20:00:00.000Z");
  });

  it("con el comprobante crea la evaluación con Meet, la confirma, y avisa a Mario con el link", async () => {
    const creados: any[] = [];
    const t = montar({
      calendario: {
        async crearEvaluacion(...a: any[]) {
          creados.push(a);
          return { link: "https://cal/ev", meet: "https://meet.google.com/abc-defg-hij" };
        },
      },
      decisiones: [decision({ comprobante: "transferencia de $40 Produbanco" })],
    });
    t.store.crearLead(LEAD, { dueno: "MARIO", nombre: "Ana Pérez" });
    t.store.actualizar(LEAD, { cita: "2026-11-26T20:00:00.000Z", modalidad: "en línea", datos_pago_enviados: 1, etapa: "Qualified" });
    await t.entrante(LEAD, "", "w1", "image", "m1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(creados[0][1]).toBe("Sesión de evaluación con Ana Pérez");
    expect(creados[0][4]).toBe(true); // en línea -> Meet
    const a = t.alLead(LEAD).map((e) => e.texto);
    expect(a[0]).toMatch(/^Ana, quedó agendada tu evaluación para el jueves, 26 de noviembre a las 15:00, en línea/);
    expect(a.some((x) => x.includes("meet.google.com"))).toBe(true);
    expect(t.aMario().some((e) => e.texto.includes("meet.google.com"))).toBe(true);
    expect(t.store.lead(LEAD)!.etapa).toBe("Agendo sesion Evaluacion");
  });

  it("presencial: envía la dirección solo cuando ya pagó", async () => {
    const t = montar({
      calendario: { async crearEvaluacion() { return { link: "x", meet: null }; } },
      decisiones: [decision({ comprobante: "ok" })],
    });
    t.store.crearLead(LEAD, { dueno: "MARIO", nombre: "Luis" });
    t.store.actualizar(LEAD, { cita: "2026-11-26T20:00:00.000Z", modalidad: "presencial" });
    await t.entrante(LEAD, "listo, transferí", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.alLead(LEAD).some((e) => e.texto.includes("Cumbayá, lote de prueba"))).toBe(true);
  });

  it("recordatorio el día anterior a la cita", async () => {
    const t = montar({ ahora: new Date("2026-11-25T14:30:00Z") }); // miércoles 09:30 Quito
    t.store.crearLead(LEAD, { dueno: "MARIO", nombre: "Ana" });
    t.store.actualizar(LEAD, { cita: "2026-11-26T20:00:00.000Z", modalidad: "en línea", etapa: "Qualified" });
    await t.motor.tick();
    expect(t.alLead(LEAD)[0].plantilla).toBe("recordatorio_evaluacion");
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(1); // una sola vez
  });
});

describe("seguimientos", () => {
  it("lead de formulario: primer contacto con plantilla tras unos minutos", async () => {
    const t = montar();
    await t.motor.ingresarLead({ telefono: "0991234567", nombre: "Ana Pérez", formulario: "Ansiedad hace años", origen: "formulario", anuncio: null });
    await t.motor.tick();
    expect(t.alLead(LEAD)).toHaveLength(0);
    t.avanzar(11 * MIN);
    await t.motor.tick();
    const p = t.alLead(LEAD)[0];
    expect(p.plantilla).toBe("primer_contacto_formulario");
    expect(p.texto).toBe("Ana|Mario|Ansiedad hace años");
  });

  it("los seguimientos son de lunes a viernes, alternando mañana y tarde", async () => {
    const t = montar({ ahora: new Date("2026-11-27T15:00:00Z") }); // viernes 10:00
    await t.motor.ingresarLead({ telefono: LEAD, nombre: "Ana", formulario: "x", origen: "formulario", anuncio: null });
    t.avanzar(11 * MIN);
    await t.motor.tick(); // primer contacto el viernes
    const toques: string[] = [];
    for (let i = 0; i < 6 * 24 * 4; i++) {
      t.avanzar(15 * MIN);
      const antes = t.alLead(LEAD).length;
      await t.motor.tick();
      if (t.alLead(LEAD).length > antes) {
        const p = partesLocales(t.ahora, "America/Guayaquil");
        toques.push(`${p.diaSemana} ${p.hora}`);
      }
    }
    expect(toques.length).toBeGreaterThanOrEqual(3);
    expect(toques.every((x) => !x.startsWith("Sat") && !x.startsWith("Sun"))).toBe(true);
    const horas = toques.map((x) => Number(x.split(" ")[1]));
    expect(horas.some((h) => h < 12)).toBe(true);
    expect(horas.some((h) => h >= 15)).toBe(true);
  });

  it("no usa la plantilla de primer mensaje si el chat ya tenía conversación", async () => {
    const t = montar();
    await t.eco(LEAD, "Hola, soy Mario", "e1");
    t.store.actualizar(LEAD, { pausado: 0, motivo_pausa: null, paso: "nuevo", proximo_toque: t.ahora.toISOString() });
    await t.motor.tick();
    expect(t.alLead(LEAD).filter((e) => e.plantilla?.startsWith("primer"))).toHaveLength(0);
  });

  it("quien dijo que no a todo sale del seguimiento", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("Entendido, gracias por decírmelo.")], datos: [{ campo: "no_explicito", valor: "sí" }] })] });
    await t.entrante(LEAD, "no gracias, no me interesa", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.store.lead(LEAD)!.proximo_toque).toBeNull();
  });

  it("fecha acordada: no se escribe antes", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("Gracias por avisar. ¿Te escribo cuando regreses?")], datos: [{ campo: "fecha_acordada", valor: "2027-01-11" }] })] });
    await t.entrante(LEAD, "estoy de viaje hasta enero", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(new Date(t.store.lead(LEAD)!.proximo_toque!) >= new Date("2027-01-11T05:00:00Z")).toBe(true);
  });
});

describe("etapas y comandos", () => {
  it("el agente no baja etapas ni marca Agendó por su cuenta", async () => {
    const t = montar({ decisiones: [decision({ mensajes: [msg("ok")], etapa: "Agendo sesion Evaluacion" })] });
    t.store.crearLead(LEAD, { dueno: "MARIO" });
    t.store.actualizar(LEAD, { etapa: "Qualified" });
    await t.entrante(LEAD, "hola", "w1");
    t.avanzar(11 * MIN);
    await t.motor.tick();
    expect(t.store.lead(LEAD)!.etapa).toBe("Qualified");
  });

  it("DUEÑO reasigna y libera chats iniciados desde la app", async () => {
    const t = montar();
    await t.eco(LEAD, "Hola", "e1");
    expect(t.store.lead(LEAD)!.pausado).toBe(1);
    await t.motor.comandoAdmin(MARIO, "DUEÑO 0991234567 DANI");
    expect(t.store.lead(LEAD)!.dueno).toBe("DANI");
    expect(t.store.lead(LEAD)!.pausado).toBe(0);
  });
});
