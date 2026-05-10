import { describe, it, expect, vi, beforeEach } from "vitest";

const handlers: Record<string, Function> = {};
const mockBot = {
  on: vi.fn((event: string, handler: Function) => { handlers[event] = handler; }),
  launch: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  telegram: { sendMessage: vi.fn().mockResolvedValue({}), editMessageText: vi.fn().mockResolvedValue({}) },
  __handlers: handlers,
};

vi.mock("telegraf", () => {
  class FakeTelegraf {
    on = mockBot.on;
    launch = mockBot.launch;
    stop = mockBot.stop;
    telegram = mockBot.telegram;
    constructor() {}
  }
  return { Telegraf: FakeTelegraf };
});

import { TelegramTransport } from "../src/transports/telegram.js";

function getHandler(event: string): Function {
  const call = mockBot.on.mock.calls.find((c: any[]) => c[0] === event);
  return call![1];
}

describe("TelegramTransport", () => {
  let transport: TelegramTransport;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn().mockResolvedValue("reply text");
    transport = new TelegramTransport({ token: "test-token", onMessage });
  });

  it("registers text, voice, and photo handlers", () => {
    expect(mockBot.on).toHaveBeenCalledWith("text", expect.any(Function));
    expect(mockBot.on).toHaveBeenCalledWith("voice", expect.any(Function));
    expect(mockBot.on).toHaveBeenCalledWith("photo", expect.any(Function));
  });

  it("start calls bot.launch", async () => {
    await transport.start();
    expect(mockBot.launch).toHaveBeenCalled();
  });

  it("stop calls bot.stop", async () => {
    await transport.stop();
    expect(mockBot.stop).toHaveBeenCalled();
  });

  it("text handler calls onMessage and edits placeholder", async () => {
    const handler = getHandler("text");
    const ctx = {
      chat: { id: 123 },
      from: { id: 456 },
      message: { text: "hello" },
      reply: vi.fn().mockResolvedValue({ message_id: 99 }),
      telegram: mockBot.telegram,
    };

    await handler(ctx);

    expect(onMessage).toHaveBeenCalledWith({
      channel: "telegram",
      senderId: "456",
      text: "hello",
      sessionId: "123",
    });
    expect(mockBot.telegram.editMessageText).toHaveBeenCalledWith(123, 99, undefined, "reply text");
  });

  it("voice handler downloads file and transcribes", async () => {
    const handler = getHandler("voice");
    const ctx = {
      chat: { id: 123 },
      from: { id: 456 },
      message: { voice: { file_id: "file123" } },
      reply: vi.fn().mockResolvedValue({}),
      telegram: { getFileLink: vi.fn().mockResolvedValue({ href: "https://example.com/voice.ogg" }) },
    };

    // Mock fetch for file download
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) }) as any;

    await handler(ctx);

    // With no voiceConfig, transcribe returns fallback, which is passed to onMessage
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "telegram",
      text: "[transcription unavailable — configure voice.whisper_url]",
    }));
    expect(ctx.reply).toHaveBeenCalledWith("reply text");

    globalThis.fetch = originalFetch;
  });

  it("send delivers message to stored session chat", async () => {
    const handler = getHandler("text");
    const ctx = {
      chat: { id: 789 },
      from: { id: 1 },
      message: { text: "hi" },
      reply: vi.fn().mockResolvedValue({ message_id: 1 }),
      telegram: mockBot.telegram,
    };
    await handler(ctx);

    await transport.send("789", "outbound msg");
    expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(789, "outbound msg");
  });
});
