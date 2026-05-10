import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface SttConfig {
  voice?: { whisper_url?: string };
}

export async function transcribe(audioPath: string, config: SttConfig): Promise<string> {
  if (!config.voice?.whisper_url) {
    return "[transcription unavailable — configure voice.whisper_url]";
  }

  const file = readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([file]), basename(audioPath));
  form.append("model", "whisper-1");

  const res = await fetch(`${config.voice.whisper_url}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) throw new Error(`Whisper STT failed: ${res.status}`);
  const json = (await res.json()) as { text: string };
  return json.text;
}
