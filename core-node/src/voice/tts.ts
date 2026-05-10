export interface TtsConfig {
  voice?: { elevenlabs_api_key?: string; elevenlabs_voice_id?: string };
}

export async function speak(text: string, config: TtsConfig): Promise<Buffer> {
  if (!config.voice?.elevenlabs_api_key) {
    console.log("[voice] TTS not configured — set voice.elevenlabs_api_key");
    return Buffer.alloc(0);
  }

  const voiceId = config.voice.elevenlabs_voice_id ?? "21m00Tcm4TlvDq8ikWAM";
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": config.voice.elevenlabs_api_key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, model_id: "eleven_monolingual_v1" }),
  });

  if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
