import { Telegraf } from "telegraf";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Transport } from "./base.js";
import { transcribe, type SttConfig } from "../voice/stt.js";
import type { PairingManager } from "../security/pairing.js";
import { sanitizeContext } from "../memory/scrubber.js";

/**
 * Split text into chunks <= maxLen (Telegram hard limit is 4096 but leave
 * headroom for unicode expansion). Breaks at paragraph > line > sentence >
 * word boundaries in that order before falling back to hard character cuts.
 */
function chunkTelegramText(text: string, maxLen = 4000): string[] {
  if (!text) return [""];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cutAt = maxLen;
    // Prefer paragraph boundary
    const paraBreak = remaining.lastIndexOf("\n\n", maxLen);
    const lineBreak = remaining.lastIndexOf("\n", maxLen);
    const sentenceBreak = remaining.lastIndexOf(". ", maxLen);
    const spaceBreak = remaining.lastIndexOf(" ", maxLen);
    if (paraBreak > maxLen * 0.5) cutAt = paraBreak + 2;
    else if (lineBreak > maxLen * 0.5) cutAt = lineBreak + 1;
    else if (sentenceBreak > maxLen * 0.5) cutAt = sentenceBreak + 2;
    else if (spaceBreak > maxLen * 0.5) cutAt = spaceBreak + 1;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

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
    // Telegraf 4.x: bot.launch() returns a Promise that resolves when the bot
    // stops, not when it starts. Don't await it or start() never returns.
    // Pass dropPendingUpdates so a restart doesn't replay old messages.
    this.bot.launch({ dropPendingUpdates: true }).catch((e: any) => {
      console.error("[telegram] launch error:", e?.message ?? e);
    });
  }

  async stop(): Promise<void> {
    this.bot.stop();
  }

  async send(sessionId: string, text: string): Promise<void> {
    const chatId = this.sessions.get(sessionId);
    if (!chatId) return;
    // Strip any leaked <memory-context> blocks (defense-in-depth — the
    // orchestrator already sanitizes, but bots are public-facing so we
    // double up).
    const safe = sanitizeContext(text);
    // Telegram hard limit is 4096 chars per message. Split cleanly on
    // paragraph/line boundaries so we don't cut a word or tool-result in half.
    const chunks = chunkTelegramText(safe, 4000);
    for (const chunk of chunks) {
      await this.bot.telegram.sendMessage(chatId, chunk);
    }
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

        const safe = sanitizeContext(response);
        const chunks = chunkTelegramText(safe, 4000);
        // Edit the "..." placeholder with the first chunk, send the rest as
        // new messages to preserve ordering.
        try {
          await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined, chunks[0] || "(no response)");
        } catch (editErr: any) {
          // If the edit fails (message too long for edit API, etc.), send fresh.
          console.error("[telegram] editMessageText failed, falling back to send:", editErr?.message ?? editErr);
          await ctx.reply(chunks[0] || "(no response)");
        }
        for (let i = 1; i < chunks.length; i++) {
          await ctx.reply(chunks[i]);
        }
      } catch (e: any) {
        console.error("[telegram] text handler error:", e?.message ?? e);
        try { await ctx.reply("Error: " + (e?.message ?? "unknown").slice(0, 200)); } catch { /* */ }
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

        const safe = sanitizeContext(response);
        const chunks = chunkTelegramText(safe, 4000);
        for (const chunk of chunks) await ctx.reply(chunk);
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
