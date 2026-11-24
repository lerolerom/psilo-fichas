import crypto from "node:crypto";
import { normalizarTelefono } from "./config.js";

/** Lo mínimo que el resto del sistema necesita de WhatsApp. Facilita pruebas sin red. */
export interface WhatsApp {
  enviarTexto(to: string, texto: string): Promise<string>;
  enviarPlantilla(to: string, nombre: string, params: string[]): Promise<string>;
  marcarLeido(waMessageId: string): Promise<void>;
  /** Descarga un adjunto (imagen, PDF). Devuelve null si no se puede. */
  descargarMedia?(mediaId: string): Promise<{ mime: string; data: Buffer } | null>;
}

export class WhatsAppCloud implements WhatsApp {
  constructor(
    private opts: { phoneNumberId: string; token: string; version: string; idioma: string },
  ) {}

  private async post(body: unknown): Promise<any> {
    const url = `https://graph.facebook.com/${this.opts.version}/${this.opts.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`WhatsApp ${res.status}: ${JSON.stringify(json?.error ?? json)}`);
    }
    return json;
  }

  async enviarTexto(to: string, texto: string): Promise<string> {
    const r = await this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: texto, preview_url: true },
    });
    return r.messages?.[0]?.id ?? "";
  }

  async enviarPlantilla(to: string, nombre: string, params: string[]): Promise<string> {
    const r = await this.post({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: nombre,
        language: { code: this.opts.idioma },
        components: params.length
          ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
          : [],
      },
    });
    return r.messages?.[0]?.id ?? "";
  }

  async marcarLeido(waMessageId: string): Promise<void> {
    await this.post({ messaging_product: "whatsapp", status: "read", message_id: waMessageId });
  }

  async descargarMedia(mediaId: string): Promise<{ mime: string; data: Buffer } | null> {
    const auth = { Authorization: `Bearer ${this.opts.token}` };
    const meta = await fetch(`https://graph.facebook.com/${this.opts.version}/${mediaId}`, { headers: auth });
    if (!meta.ok) return null;
    const j: any = await meta.json();
    if (!j.url) return null;
    const bin = await fetch(j.url, { headers: auth });
    if (!bin.ok) return null;
    return { mime: String(j.mime_type ?? bin.headers.get("content-type") ?? ""), data: Buffer.from(await bin.arrayBuffer()) };
  }
}

/** Valida X-Hub-Signature-256 (HMAC SHA-256 del cuerpo crudo con el App Secret). */
export function firmaValida(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret) return true; // en desarrollo sin secreto configurado
  if (!header?.startsWith("sha256=")) return false;
  const esperado = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const recibido = header.slice("sha256=".length);
  if (recibido.length !== esperado.length) return false;
  return crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(esperado));
}

// ---------- Parseo de webhooks ----------

export type EventoWA =
  | {
      tipo: "entrante";
      de: string;
      nombrePerfil: string | null;
      waId: string;
      ts: Date;
      clase: string; // text | audio | image | ...
      texto: string;
      referral: { headline?: string; body?: string; source_url?: string; source_type?: string } | null;
      mediaId?: string;
      formulario?: string; // respuesta de un formulario dentro de WhatsApp (Flow del anuncio)
      historial?: boolean; // vino de la sincronización de historial de la coexistencia
    }
  | { tipo: "eco"; para: string; waId: string; ts: Date; clase: string; texto: string; historial?: boolean }
  | { tipo: "estado"; waId: string; estado: string; para: string; error?: string }
  | { tipo: "leadgen"; leadgenId: string; formId?: string; adId?: string };

function textoDe(m: any): string {
  switch (m?.type) {
    case "text":
      return m.text?.body ?? "";
    case "button":
      return m.button?.text ?? "";
    case "interactive":
      if (m.interactive?.nfm_reply) return formularioDe(m) ?? "[formulario]";
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
    case "image":
    case "video":
    case "document":
      return m[m.type]?.caption ?? "";
    case "reaction":
      return m.reaction?.emoji ?? "";
    default:
      return "";
  }
}

/** Respuesta de un formulario (WhatsApp Flow) del anuncio: "pregunta: respuesta" por línea. */
function formularioDe(m: any): string | undefined {
  const raw = m?.interactive?.nfm_reply?.response_json;
  if (!raw) return undefined;
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    const lineas = Object.entries(j)
      .filter(([k]) => k !== "flow_token")
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    return lineas.join("\n") || undefined;
  } catch {
    return String(raw);
  }
}

function mediaIdDe(m: any): string | undefined {
  return m?.image?.id ?? m?.document?.id ?? m?.audio?.id ?? m?.video?.id ?? m?.sticker?.id;
}

function fecha(ts: unknown): Date {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/**
 * Convierte el payload del webhook en eventos planos.
 * - field "messages": mensajes entrantes (value.messages[]) y estados (value.statuses[]).
 * - field "smb_message_echoes" (coexistencia): lo que el equipo escribe desde la app WhatsApp Business.
 * - field "leadgen" (objeto page): formularios instantáneos de Meta.
 */
export function parsearWebhook(body: any): EventoWA[] {
  const eventos: EventoWA[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      const field = change?.field;

      if (field === "leadgen") {
        if (v.leadgen_id) eventos.push({ tipo: "leadgen", leadgenId: String(v.leadgen_id), formId: v.form_id, adId: v.ad_id });
        continue;
      }

      const nombres = new Map<string, string>();
      for (const c of v.contacts ?? []) {
        if (c?.wa_id) nombres.set(normalizarTelefono(c.wa_id), c?.profile?.name ?? null);
      }

      for (const m of v.messages ?? []) {
        const de = normalizarTelefono(String(m.from ?? ""));
        eventos.push({
          tipo: "entrante",
          de,
          nombrePerfil: nombres.get(de) ?? null,
          waId: String(m.id),
          ts: fecha(m.timestamp),
          clase: String(m.type ?? "unknown"),
          texto: textoDe(m),
          referral: m.referral ?? null,
          mediaId: mediaIdDe(m),
          formulario: formularioDe(m),
        });
      }

      for (const m of v.message_echoes ?? []) {
        eventos.push({
          tipo: "eco",
          para: normalizarTelefono(String(m.to ?? "")),
          waId: String(m.id),
          ts: fecha(m.timestamp),
          clase: String(m.type ?? "unknown"),
          texto: textoDe(m),
        });
      }

      // Sincronización de historial al activar la coexistencia: mensajes viejos del chat.
      if (field === "history") {
        const propio = normalizarTelefono(String(v.metadata?.display_phone_number ?? ""));
        for (const m of mensajesAnidados(v)) {
          const de = normalizarTelefono(String(m.from ?? ""));
          const para = normalizarTelefono(String(m.to ?? ""));
          const nuestro = (propio && de === propio) || m.from_me === true || m.history_context?.from_me === true;
          if (nuestro && para) {
            eventos.push({ tipo: "eco", para, waId: String(m.id), ts: fecha(m.timestamp), clase: String(m.type ?? "unknown"), texto: textoDe(m), historial: true });
          } else if (de) {
            eventos.push({
              tipo: "entrante",
              de,
              nombrePerfil: null,
              waId: String(m.id),
              ts: fecha(m.timestamp),
              clase: String(m.type ?? "unknown"),
              texto: textoDe(m),
              referral: null,
              historial: true,
            });
          }
        }
        continue;
      }

      for (const s of v.statuses ?? []) {
        eventos.push({
          tipo: "estado",
          waId: String(s.id),
          estado: String(s.status),
          para: normalizarTelefono(String(s.recipient_id ?? "")),
          error: s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title}` : undefined,
        });
      }
    }
  }
  return eventos;
}

/** Busca mensajes (objetos con id, timestamp y from/to) en cualquier nivel del payload de historial. */
function mensajesAnidados(v: any, out: any[] = [], prof = 0): any[] {
  if (!v || typeof v !== "object" || prof > 8) return out;
  if (Array.isArray(v)) {
    for (const x of v) mensajesAnidados(x, out, prof + 1);
    return out;
  }
  if (typeof v.id === "string" && v.timestamp && (v.from || v.to) && v.type) {
    out.push(v);
    return out;
  }
  for (const k of Object.keys(v)) mensajesAnidados(v[k], out, prof + 1);
  return out;
}

/** Lee un lead de formulario instantáneo (Graph API) y lo aplana. */
export async function leerLeadgen(
  leadgenId: string,
  pageToken: string,
  version: string,
): Promise<{ telefono: string; nombre: string | null; respuestas: string; adName: string | null } | null> {
  const url = `https://graph.facebook.com/${version}/${leadgenId}?fields=field_data,ad_name,form_id&access_token=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j: any = await res.json();
  const campos: Record<string, string> = {};
  for (const f of j.field_data ?? []) campos[f.name] = (f.values ?? []).join(", ");
  const tel = campos.phone_number ?? campos.telefono ?? campos["número_de_teléfono"] ?? "";
  if (!tel) return null;
  const nombre = campos.full_name ?? campos.first_name ?? campos.nombre ?? null;
  const ignorar = new Set(["phone_number", "telefono", "full_name", "first_name", "last_name", "email", "nombre"]);
  const respuestas = Object.entries(campos)
    .filter(([k]) => !ignorar.has(k))
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join("\n");
  return { telefono: normalizarTelefono(tel), nombre, respuestas, adName: j.ad_name ?? null };
}
