import crypto from "node:crypto";
import type { Lead } from "./db.js";

/**
 * API de Conversiones de Meta: le cuenta a Meta qué pasó con cada lead para que optimice los anuncios
 * hacia leads que califican (lo que hoy se hace a mano en el Leads Center).
 *
 * - Lead de formulario instantáneo: evento de CRM con el lead_id (Conversiones para CRM).
 *   El nombre del evento es la etapa tal cual, como en el Leads Center.
 * - Lead que llegó por un anuncio que abre WhatsApp: evento de mensajería con el ctwa_clid del primer mensaje.
 *   Solo para las etapas que tienen evento estándar (META_EVENTOS_WHATSAPP).
 *
 * Verificar los nombres de campos contra la documentación vigente de Meta antes de activarlo.
 */
export interface Conversiones {
  enviar(lead: Lead, etapa: string, ts: Date): Promise<"enviado" | "omitido">;
}

export function hashTelefono(tel: string): string {
  return crypto.createHash("sha256").update(tel.replace(/\D/g, "")).digest("hex");
}

export class MetaConversiones implements Conversiones {
  private mapaWhatsapp: Map<string, string>;

  constructor(
    private o: { datasetId: string; token: string; wabaId: string; version: string; nombreCrm: string; eventosWhatsapp: string },
  ) {
    this.mapaWhatsapp = new Map(
      o.eventosWhatsapp
        .split(",")
        .map((x) => x.split(":").map((y) => y.trim()))
        .filter((x) => x.length === 2 && x[0] && x[1]) as [string, string][],
    );
  }

  /** Arma el evento, o null si este lead no tiene cómo atribuirse a un anuncio. */
  evento(lead: Lead, etapa: string, ts: Date): Record<string, unknown> | null {
    const eventTime = Math.floor(ts.getTime() / 1000);
    if (lead.leadgen_id) {
      return {
        event_name: etapa,
        event_time: eventTime,
        action_source: "system_generated",
        custom_data: { event_source: "crm", lead_event_source: this.o.nombreCrm },
        // Como texto: los ID de Meta pueden pasar el límite de precisión de los números en JavaScript.
        user_data: { lead_id: lead.leadgen_id, ph: [hashTelefono(lead.telefono)] },
      };
    }
    if (lead.ctwa_clid) {
      const nombre = this.mapaWhatsapp.get(etapa);
      if (!nombre) return null;
      return {
        event_name: nombre,
        event_time: eventTime,
        action_source: "business_messaging",
        messaging_channel: "whatsapp",
        user_data: { whatsapp_business_account_id: this.o.wabaId, ctwa_clid: lead.ctwa_clid },
      };
    }
    return null;
  }

  async enviar(lead: Lead, etapa: string, ts: Date): Promise<"enviado" | "omitido"> {
    const ev = this.evento(lead, etapa, ts);
    if (!ev) return "omitido";
    const url = `https://graph.facebook.com/${this.o.version}/${this.o.datasetId}/events?access_token=${encodeURIComponent(this.o.token)}`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: [ev] }) });
    if (!res.ok) throw new Error(`Meta ${res.status}: ${await res.text().catch(() => "")}`);
    return "enviado";
  }
}
