/**
 * Transcripción de audios con Whisper corriendo en un contenedor propio (gratis; el audio no sale del servidor).
 * Usa la API compatible con OpenAI que exponen servidores como speaches / faster-whisper-server:
 *   POST {WHISPER_URL}/v1/audio/transcriptions  (multipart: file, model, language) -> { text }
 */
export interface Transcriptor {
  transcribir(audio: Buffer, mime: string): Promise<string | null>;
}

export class WhisperLocal implements Transcriptor {
  constructor(
    private url: string,
    private modelo: string,
  ) {}

  async transcribir(audio: Buffer, mime: string): Promise<string | null> {
    const form = new FormData();
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : mime.includes("mp4") ? "m4a" : "ogg";
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/ogg" }), `audio.${ext}`);
    form.append("model", this.modelo);
    form.append("language", "es");
    form.append("response_format", "json");
    const res = await fetch(`${this.url.replace(/\/$/, "")}/v1/audio/transcriptions`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Whisper ${res.status}: ${await res.text().catch(() => "")}`);
    const j: any = await res.json();
    const texto = String(j.text ?? "").trim();
    return texto || null;
  }
}
