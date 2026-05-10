import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import type { Transport } from "./base.js";

export interface DiscordTransportOptions {
  token: string;
  onMessage: (ctx: { channel: string; senderId: string; text: string; sessionId: string }) => Promise<string>;
}

export class DiscordTransport implements Transport {
  name = "discord";
  private client: Client | null = null;
  private token: string;
  private onMessage: DiscordTransportOptions["onMessage"];

  constructor(opts: DiscordTransportOptions) {
    this.token = opts.token;
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on("messageCreate", async (msg) => {
      if (msg.author.bot) return;
      try {
        const sessionId = msg.channelId;
        const response = await this.onMessage({
          channel: "discord",
          senderId: msg.author.id,
          text: msg.content,
          sessionId,
        });
        await msg.reply(response);
      } catch (e: any) {
        console.error("[discord] messageCreate error:", e?.message ?? e);
      }
    });

    await this.client.login(this.token);
  }

  async send(sessionId: string, text: string): Promise<void> {
    const channel = await this.client?.channels.fetch(sessionId);
    if (channel && channel instanceof TextChannel) {
      await channel.send(text);
    }
  }

  async stop(): Promise<void> {
    this.client?.destroy();
  }
}
