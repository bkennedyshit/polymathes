import { describe, it, expect, vi, afterEach } from "vitest";
import { transcribe } from "../src/voice/stt.js";
import { speak } from "../src/voice/tts.js";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("voice/stt", () => {
  it("returns fallback when no config", async () => {
    const result = await transcribe("/fake/audio.ogg", {});
    expect(result).toBe("[transcription unavailable — configure voice.whisper_url]");
  });

  it("returns fallback when voice config has no whisper_url", async () => {
    const result = await transcribe("/fake/audio.ogg", { voice: {} });
    expect(result).toBe("[transcription unavailable — configure voice.whisper_url]");
  });
});

describe("voice/tts", () => {
  it("returns empty Buffer when no config", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await speak("hello", {});
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(0);
    logSpy.mockRestore();
  });

  it("returns empty Buffer when voice config has no key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await speak("hello", { voice: {} });
    expect(result.length).toBe(0);
    logSpy.mockRestore();
  });
});

describe("onboard/wizard config writing", () => {
  const testDir = join(tmpdir(), "polymath-test-onboard-" + Date.now());

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("writes config file to specified directory", async () => {
    // We test the config-writing logic by importing and calling with a mock readline
    const { runOnboard } = await import("../src/onboard/wizard.js");
    const readline = await import("node:readline");

    const answers = ["openai", "sk-fake-key-123", "", testDir, ""];
    let idx = 0;

    const mockRl = {
      question: (_q: string, cb: (answer: string) => void) => cb(answers[idx++] || ""),
      close: () => {},
    } as unknown as readline.Interface;

    // Mock fetch for the LLM test call
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runOnboard({ rl: mockRl });

    globalThis.fetch = originalFetch;
    logSpy.mockRestore();

    const configPath = join(testDir, "polymath.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.api_key).toBe("sk-fake-key-123");
  });
});
