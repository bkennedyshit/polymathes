import { Telegraf } from "telegraf";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Transport } from "./base.js";
import { transcribe, type SttConfig } from "../voice/stt.js";
import type { PairingManager } from "../security/pairing.js";

export interface TelegramTransportOptions {
  token: string;
  voiceConfig?: SttConfig;
  onMessage: (ctx: { channel: string; senderId: string; text: string; sessionId: string }) => Promise<string>;
}

export class TelegramTransport implements Transport {
  name = "telegram";
  private bot: Telegraf;
  private onMessage: TelegramTransportOptions["onMessage"];
  private voiceConfig: SttConfig;
  private sessions = new Map<string, number>();
  private pairingManager: PairingManager | null = null;

  constructor(opts: TelegramTransportOptions) {
    this.bot = new Telegraf(opts.token);
    this.onMessage = opts.onMessage;
    this.voiceConfig = opts.voiceConfig ?? {};
    this.setupHandlers();
  }

  setPairingManager(pm: PairingManager): void {
    this.pairingManager = pm;
  }

  async start(): Promise<void> {
    await this.bot.launch();
  }

  async stop(): Promise<void> {
    this.bot.stop();
  }

  async send(sessionId: string, text: string): Promise<void> {
    const chatId = this.sessions.get(sessionId);
    if (chatId) await this.bot.telegram.sendMessage(chatId, text);
  }

  private checkSender(senderId: string): "approved" | "pending" | "unknown" {
    if (!this.pairingManager) return "approved";
    return this.pairingManager.checkSender("telegram", senderId);
  }

  private setupHandlers(): void {
    this.bot.on("text", async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const sessionId = String(chatId);
        const senderId = String(ctx.from.id);
        this.sessions.set(sessionId, chatId);

        const status = this.checkSender(senderId);
        if (status === "unknown" && this.pairingManager) {
          const code = this.pairingManager.createPairing("telegram", senderId);
          await ctx.reply(`Hi! I need to verify you. Your pairing code is: ${code}. Ask the owner to run: polymath pair approve ${code}`);
          return;
        }
        if (status === "pending") {
          await ctx.reply("Your pairing is still pending approval.");
          return;
        }

        const placeholder = await ctx.reply("...");

        const response = await this.onMessage({
          channel: "telegram",
          senderId,
          text: ctx.message.text,
          sessionId,
        });

        await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined, response);
      } catch (e: any) {
        console.error("[telegram] text handler error:", e?.message ?? e);
      }
    });

    this.bot.on("voice", async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const sessionId = String(chatId);
        const senderId = String(ctx.from.id);
        this.sessions.set(sessionId, chatId);

        const status = this.checkSender(senderId);
        if (status !== "approved") {
          if (status === "unknown" && this.pairingManager) {
            const code = this.pairingManager.createPairing("telegram", senderId);
            await ctx.reply(`Hi! I need to verify you. Your pairing code is: ${code}. Ask the owner to run: polymath pair approve ${code}`);
          }
          return;
        }

        const fileId = ctx.message.voice.file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const res = await fetch(fileLink.href);
        const buf = Buffer.from(await res.arrayBuffer());

        const dir = join(tmpdir(), "polymath-voice");
        mkdirSync(dir, { recursive: true });
        const filePath = join(dir, `${fileId}.ogg`);
        writeFileSync(filePath, buf);

        const text = await transcribe(filePath, this.voiceConfig);

        const response = await this.onMessage({
          channel: "telegram",
          senderId,
          text,
          sessionId,
        });

        await ctx.reply(response);
      } catch (e: any) {
        console.error("[telegram] voice handler error:", e?.message ?? e);
      }
    });

    this.bot.on("photo", async (_ctx) => {
      try {
        console.log("[telegram] photo processing not yet wired");
      } catch (e: any) {
        console.error("[telegram] photo handler error:", e?.message ?? e);
      }
    });
  }
}
