import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOn = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn();
const mockChannelsFetch = vi.fn();

vi.mock("discord.js", () => {
  class FakeClient {
    on = mockOn;
    login = mockLogin;
    destroy = mockDestroy;
    channels = { fetch: mockChannelsFetch };
  }
  return {
    Client: FakeClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
    TextChannel: class {},
  };
});

import { DiscordTransport } from "../src/transports/discord.js";

describe("DiscordTransport", () => {
  let transport: DiscordTransport;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn().mockResolvedValue("bot reply");
    transport = new DiscordTransport({ token: "test-token", onMessage });
  });

  it("has correct name", () => {
    expect(transport.name).toBe("discord");
  });

  it("start logs in and registers messageCreate handler", async () => {
    await transport.start();
    expect(mockLogin).toHaveBeenCalledWith("test-token");
    expect(mockOn).toHaveBeenCalledWith("messageCreate", expect.any(Function));
  });

  it("stop calls client.destroy", async () => {
    await transport.start();
    await transport.stop();
    expect(mockDestroy).toHaveBeenCalled();
  });

  it("messageCreate ignores bots", async () => {
    await transport.start();
    const handler = mockOn.mock.calls.find((c: any[]) => c[0] === "messageCreate")![1];
    const msg = { author: { bot: true, id: "1" }, channelId: "ch1", content: "hi", reply: vi.fn() };
    await handler(msg);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("messageCreate calls onMessage and replies", async () => {
    await transport.start();
    const handler = mockOn.mock.calls.find((c: any[]) => c[0] === "messageCreate")![1];
    const msg = { author: { bot: false, id: "user1" }, channelId: "ch42", content: "hello", reply: vi.fn() };
    await handler(msg);
    expect(onMessage).toHaveBeenCalledWith({
      channel: "discord",
      senderId: "user1",
      text: "hello",
      sessionId: "ch42",
    });
    expect(msg.reply).toHaveBeenCalledWith("bot reply");
  });
});
