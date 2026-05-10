import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import { transcribe, type SttConfig } from "../../voice/stt.js";
import { speak, type TtsConfig } from "../../voice/tts.js";

let voiceConfig: SttConfig & TtsConfig = {};

export function setVoiceConfig(c: SttConfig & TtsConfig): void {
  voiceConfig = c;
}

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "tts",
    description: "Convert text to speech audio",
    parameters: z.object({ text: z.string(), voice: z.string().optional(), output_path: z.string().optional() }),
    async handler(params: unknown) {
      const { text } = params as { text: string };
      const buf = await speak(text, voiceConfig);
      if (buf.length === 0) return { error: "TTS not configured" };
      return { size: buf.length, format: "mp3" };
    },
    toolset: "voice",
  });

  registry.register({
    name: "stt",
    description: "Convert speech audio to text",
    parameters: z.object({ audio_path: z.string() }),
    async handler(params: unknown) {
      const { audio_path } = params as { audio_path: string };
      const text = await transcribe(audio_path, voiceConfig);
      if (text.startsWith("[transcription unavailable")) return { error: "STT not configured" };
      return { text };
    },
    toolset: "voice",
  });
}
