import express from "express";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { Motor } from "./motor.js";
import { firmaValida, leerLeadgen, parsearWebhook } from "./whatsapp.js";
import { z } from "zod";
import { htmlComparacion, htmlListaChrome } from "./panel.js";
import { partesLocales } from "./tiempo.js";

const LeadEntrada = z.object({
  telefono: z.string().min(7),
  nombre: z.string().nullish(),
  formulario: z.string().nullish(),
  origen: z.enum(["formulario", "abandonado", "instagram"]).default("formulario"),
  anuncio: z.string().nullish(),
  dueno: z.enum(["MARIO", "DANI", "VERO"]).optional(),
});

export function crearApp(cfg: Config, store: Store, motor: Motor) {
  const app = express();

  // Cuerpo crudo para validar la firma de Meta.
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    }),
  );

  app.get("/salud", (_req, res) => {
    res.json({ ok: true, modo: cfg.MODO, pendientes: store.escalacionesPendientes().length });
  });

  // Verificación del webhook (Meta llama una vez al configurarlo).
  app.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === cfg.WA_VERIFY_TOKEN) {
      res.status(200).send(String(req.query["hub.challenge"] ?? ""));
    } else {
      res.sendStatus(403);
    }
  });

  app.post("/webhook", (req, res) => {
    const raw: Buffer = (req as any).rawBody ?? Buffer.from("");
    if (!firmaValida(raw, req.header("x-hub-signature-256"), cfg.WA_APP_SECRET)) {
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200); // Meta reintenta si tardamos; el trabajo pesado lo hace el ciclo.
    const eventos = parsearWebhook(req.body);
    void (async () => {
      for (const ev of eventos) {
        if (ev.tipo === "leadgen") {
          if (!cfg.META_PAGE_ACCESS_TOKEN) continue;
          const l = await leerLeadgen(ev.leadgenId, cfg.META_PAGE_ACCESS_TOKEN, cfg.WA_GRAPH_VERSION).catch(() => null);
          if (l) {
            await motor.ingresarLead({
              telefono: l.telefono,
              nombre: l.nombre,
              formulario: l.respuestas || null,
              origen: "formulario",
              anuncio: l.adName,
              leadgenId: ev.leadgenId,
            });
          }
        }
      }
      await motor.procesar(eventos.filter((e) => e.tipo !== "leadgen"));
    })().catch((e) => console.error("webhook", e));
  });

  // API interna (Make/Zapier/landing) protegida con token.
  const auth: express.RequestHandler = (req, res, next) => {
    if (!cfg.ADMIN_API_TOKEN || req.header("authorization") !== `Bearer ${cfg.ADMIN_API_TOKEN}`) {
      res.sendStatus(401);
      return;
    }
    next();
  };

  app.post("/api/leads", auth, async (req, res) => {
    const p = LeadEntrada.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: p.error.flatten() });
      return;
    }
    const lead = await motor.ingresarLead({
      telefono: p.data.telefono,
      nombre: p.data.nombre ?? null,
      formulario: p.data.formulario ?? null,
      origen: p.data.origen,
      anuncio: p.data.anuncio ?? null,
      dueno: p.data.dueno,
    });
    res.json({ telefono: lead.telefono, etapa: lead.etapa, dueno: lead.dueno });
  });

  app.get("/api/leads.csv", auth, (_req, res) => {
    const filas = store.todos();
    const cols = ["telefono", "nombre", "dueno", "etapa", "paso", "origen", "ultimo_in", "ultimo_out", "pausado", "motivo_pausa"] as const;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    res.type("text/csv").send([cols.join(","), ...filas.map((f) => cols.map((c) => esc(c === "telefono" ? `+${f[c]}` : f[c])).join(","))].join("\n"));
  });

  app.get("/api/escalaciones", auth, (_req, res) => {
    res.json(store.escalacionesPendientes());
  });

  // Paneles para abrir en el navegador (token en la URL).
  const authPanel: express.RequestHandler = (req, res, next) => {
    if (!cfg.ADMIN_API_TOKEN || req.query.token !== cfg.ADMIN_API_TOKEN) {
      res.sendStatus(401);
      return;
    }
    next();
  };
  const fechaDe = (q: unknown) =>
    typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : partesLocales(new Date(), cfg.TZ_NEGOCIO).fecha;

  app.get("/panel/sombra", authPanel, (req, res) => {
    const fecha = fechaDe(req.query.fecha);
    const desde = new Date(`${fecha}T00:00:00-05:00`);
    const hasta = new Date(desde.getTime() + 24 * 3600_000);
    res.type("html").send(htmlComparacion(fecha, motor.comparacionSombra(desde, hasta)));
  });

  // Lista de seguimientos del día para las rondas de Chrome (HTML para leer en el navegador, JSON para programas).
  const listaChrome = (fecha: string) =>
    store.listaChrome(fecha).map((x) => ({ ...x, nombre: store.lead(x.telefono)?.nombre ?? null }));
  app.get("/panel/seguimientos", authPanel, (req, res) => {
    const fecha = fechaDe(req.query.fecha);
    res.type("html").send(htmlListaChrome(fecha, listaChrome(fecha)));
  });
  app.get("/api/seguimientos", auth, (req, res) => {
    res.json(listaChrome(fechaDe(req.query.fecha)));
  });

  return app;
}
