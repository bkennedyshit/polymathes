import { Telegraf } from "telegraf";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { ulid } from "ulid";
import type { Transport } from "./base.js";
import { transcribe, type SttConfig } from "../voice/stt.js";
import type { PairingManager } from "../security/pairing.js";
import { sanitizeContext } from "../memory/scrubber.js";
import { extractMediaArtifacts, type MediaArtifact } from "../media/artifacts.js";

const MAX_TELEGRAM_MEDIA_ATTACHMENTS = 3;
const MAX_TELEGRAM_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TELEGRAM_OTHER_BYTES = 50 * 1024 * 1024;
const MAX_TELEGRAM_INBOUND_BYTES = 100 * 1024 * 1024;

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

function extensionFromMime(mime?: string): string {
  const normalized = (mime ?? "").toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "video/quicktime") return ".mov";
  if (normalized === "video/webm") return ".webm";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/mp4") return ".m4a";
  if (normalized === "audio/wav") return ".wav";
  return ".bin";
}

function mediaKindFromMime(mime?: string): "image" | "video" | "audio" | "file" {
  const normalized = (mime ?? "").toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "file";
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
    try {
      this.bot.stop();
    } catch (e: any) {
      if (!String(e?.message ?? e).includes("Bot is not running")) throw e;
    }
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
    await this.sendMediaArtifacts(chatId, safe);
  }

  private checkSender(senderId: string): "approved" | "pending" | "unknown" {
    if (!this.pairingManager) return "approved";
    return this.pairingManager.checkSender("telegram", senderId);
  }

  private async sendMediaArtifacts(chatId: number, text: string): Promise<void> {
    const artifacts = extractMediaArtifacts(text, MAX_TELEGRAM_MEDIA_ATTACHMENTS);
    for (const artifact of artifacts) {
      await this.sendMediaArtifact(chatId, artifact);
    }
  }

  private async sendMediaArtifact(chatId: number, artifact: MediaArtifact): Promise<void> {
    const filePath = artifact.path;
    try {
      if (!existsSync(filePath)) {
        await this.bot.telegram.sendMessage(chatId, `Media file is not on this machine anymore: ${basename(filePath)}`);
        return;
      }

      const stats = statSync(filePath);
      if (!stats.isFile()) return;

      const maxBytes = artifact.kind === "image" ? MAX_TELEGRAM_IMAGE_BYTES : MAX_TELEGRAM_OTHER_BYTES;
      if (stats.size > maxBytes) {
        const mb = Math.ceil(stats.size / 1024 / 1024);
        const cap = Math.floor(maxBytes / 1024 / 1024);
        await this.bot.telegram.sendMessage(chatId, `Media is ${mb} MB, over the Telegram send cap I use here (${cap} MB). Path: ${filePath}`);
        return;
      }

      const caption = basename(filePath).slice(0, 900);
      const source = { source: filePath };

      if (artifact.kind === "image") {
        await this.bot.telegram.sendPhoto(chatId, source, { caption });
        return;
      }
      if (artifact.kind === "video") {
        await this.bot.telegram.sendVideo(chatId, source, { caption, supports_streaming: true });
        return;
      }
      if (artifact.kind === "audio") {
        await this.bot.telegram.sendAudio(chatId, source, { caption });
        return;
      }
    } catch (e: any) {
      try {
        await this.bot.telegram.sendDocument(chatId, { source: filePath }, { caption: basename(filePath).slice(0, 900) });
      } catch (fallbackErr: any) {
        console.error("[telegram] media send failed:", fallbackErr?.message ?? fallbackErr, "source:", e?.message ?? e);
        try {
          await this.bot.telegram.sendMessage(chatId, `I found media but Telegram could not upload it. Path: ${filePath}`);
        } catch { /* ignore */ }
      }
    }
  }

  private async downloadTelegramFile(opts: {
    fileId: string;
    sessionId: string;
    fallbackName: string;
    mime?: string;
    caption?: string;
  }): Promise<{ path: string; size: number; kind: string; caption?: string }> {
    const fileLink = await this.bot.telegram.getFileLink(opts.fileId);
    const ext = extname(opts.fallbackName) || extensionFromMime(opts.mime);
    const safeName = basename(opts.fallbackName || `telegram-${ulid()}${ext}`).replace(/[^\w.-]+/g, "_");
    const dir = join(homedir(), ".polymath", "inbox", "telegram", opts.sessionId);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${ulid()}-${safeName.endsWith(ext) ? safeName : safeName + ext}`);

    const res = await fetch(fileLink.href);
    if (!res.ok) throw new Error(`telegram file download failed: ${res.status} ${res.statusText}`);
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength > MAX_TELEGRAM_INBOUND_BYTES) {
      const mb = Math.ceil(contentLength / 1024 / 1024);
      throw new Error(`telegram attachment is ${mb} MB; max inbound cap is ${Math.floor(MAX_TELEGRAM_INBOUND_BYTES / 1024 / 1024)} MB`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_TELEGRAM_INBOUND_BYTES) {
      const mb = Math.ceil(buf.length / 1024 / 1024);
      throw new Error(`telegram attachment is ${mb} MB; max inbound cap is ${Math.floor(MAX_TELEGRAM_INBOUND_BYTES / 1024 / 1024)} MB`);
    }
    writeFileSync(filePath, buf);

    return {
      path: filePath,
      size: buf.length,
      kind: mediaKindFromMime(opts.mime),
      caption: opts.caption?.trim() || undefined,
    };
  }

  private attachmentPrompt(attachment: { path: string; size: number; kind: string; caption?: string }, userText?: string): string {
    const mb = (attachment.size / 1024 / 1024).toFixed(1);
    const parts = [
      userText?.trim() || attachment.caption || "I sent an attachment.",
      "",
      "[Attached media]",
      `- path: ${attachment.path}`,
      `- kind: ${attachment.kind}`,
      `- size_mb: ${mb}`,
      "- source: telegram upload",
      "",
      "Treat this as session context first. Do not add it to permanent media memory or run a broad media index unless the user explicitly asks to add/save/index/remember it.",
    ];
    if (attachment.caption && attachment.caption !== userText?.trim()) parts.splice(4, 0, `- caption: ${attachment.caption}`);
    return parts.join("\n");
  }

  private async handleInboundAttachment(ctx: any, attachment: { path: string; size: number; kind: string; caption?: string }, userText?: string): Promise<void> {
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

    const prompt = this.attachmentPrompt(attachment, userText);
    const response = await this.onMessage({
      channel: "telegram",
      senderId,
      text: prompt,
      sessionId,
    });

    const safe = sanitizeContext(response);
    const chunks = chunkTelegramText(safe, 4000);
    for (const chunk of chunks) await ctx.reply(chunk);
    await this.sendMediaArtifacts(chatId, safe);
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
        await this.sendMediaArtifacts(chatId, safe);
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
        await this.sendMediaArtifacts(chatId, safe);
      } catch (e: any) {
        console.error("[telegram] voice handler error:", e?.message ?? e);
      }
    });

    this.bot.on("photo", async (ctx) => {
      try {
        const photos = ctx.message.photo ?? [];
        const best = photos[photos.length - 1];
        if (!best) return;
        const attachment = await this.downloadTelegramFile({
          fileId: best.file_id,
          sessionId: String(ctx.chat.id),
          fallbackName: `telegram-photo-${best.file_unique_id}.jpg`,
          mime: "image/jpeg",
          caption: ctx.message.caption,
        });
        await this.handleInboundAttachment(ctx, attachment, ctx.message.caption);
      } catch (e: any) {
        console.error("[telegram] photo handler error:", e?.message ?? e);
        try { await ctx.reply("Error handling Telegram photo: " + (e?.message ?? "unknown").slice(0, 200)); } catch { /* ignore */ }
      }
    });

    this.bot.on("video", async (ctx) => {
      try {
        const video = ctx.message.video;
        if (video.file_size && video.file_size > MAX_TELEGRAM_INBOUND_BYTES) {
          await ctx.reply(`That video is ${Math.ceil(video.file_size / 1024 / 1024)} MB. I won't pull it into session context unless the inbound cap is raised.`);
          return;
        }
        const attachment = await this.downloadTelegramFile({
          fileId: video.file_id,
          sessionId: String(ctx.chat.id),
          fallbackName: video.file_name || `telegram-video-${video.file_unique_id}.mp4`,
          mime: video.mime_type || "video/mp4",
          caption: ctx.message.caption,
        });
        await this.handleInboundAttachment(ctx, attachment, ctx.message.caption);
      } catch (e: any) {
        console.error("[telegram] video handler error:", e?.message ?? e);
        try { await ctx.reply("Error handling Telegram video: " + (e?.message ?? "unknown").slice(0, 200)); } catch { /* ignore */ }
      }
    });

    this.bot.on("document", async (ctx) => {
      try {
        const doc = ctx.message.document;
        const kind = mediaKindFromMime(doc.mime_type);
        if (kind === "file") {
          await ctx.reply("I received the file, but only image/video/audio attachments are wired into media context right now.");
          return;
        }
        if (doc.file_size && doc.file_size > MAX_TELEGRAM_INBOUND_BYTES) {
          await ctx.reply(`That file is ${Math.ceil(doc.file_size / 1024 / 1024)} MB. I won't pull it into session context unless the inbound cap is raised.`);
          return;
        }
        const attachment = await this.downloadTelegramFile({
          fileId: doc.file_id,
          sessionId: String(ctx.chat.id),
          fallbackName: doc.file_name || `telegram-upload-${doc.file_unique_id}${extensionFromMime(doc.mime_type)}`,
          mime: doc.mime_type,
          caption: ctx.message.caption,
        });
        await this.handleInboundAttachment(ctx, attachment, ctx.message.caption);
      } catch (e: any) {
        console.error("[telegram] document handler error:", e?.message ?? e);
        try { await ctx.reply("Error handling Telegram file: " + (e?.message ?? "unknown").slice(0, 200)); } catch { /* ignore */ }
      }
    });
  }
}
