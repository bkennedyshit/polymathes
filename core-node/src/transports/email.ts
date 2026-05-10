import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import type { Transport } from "./base.js";
import type { PairingManager } from "../security/pairing.js";

export interface EmailTransportOptions {
  imap: {
    host: string;
    port: number;                 // 993 TLS, 143 plain
    user: string;
    pass: string;
    secure?: boolean;             // default true
  };
  smtp: {
    host: string;
    port: number;                 // 465 TLS, 587 STARTTLS
    user: string;
    pass: string;
    secure?: boolean;             // default true
    from?: string;                // defaults to smtp.user
  };
  /** Poll interval in ms when IMAP IDLE isn't supported. Default 30s. */
  pollIntervalMs?: number;
  /** Subject prefix to watch for. Only mails whose subject starts with this are delivered to the agent. Default: "[polymath]". */
  subjectPrefix?: string;
  onMessage: (ctx: { channel: string; senderId: string; text: string; sessionId: string }) => Promise<string>;
}

/**
 * Email transport.
 *
 * Inbound: holds an IMAP connection, uses IDLE where supported (Gmail, FastMail, most modern servers)
 * and falls back to a poll loop otherwise. Every unseen message in INBOX whose Subject starts with
 * the configured prefix gets flagged as seen and handed to the agent. The agent reply is then sent
 * back via SMTP as a Re:-prefixed response to the sender.
 *
 * Outbound: SMTP via nodemailer.
 *
 * sessionId is the sender's email address so a thread with one user persists across messages.
 */
export class EmailTransport implements Transport {
  name = "email";

  private opts: EmailTransportOptions;
  private imap: ImapFlow | null = null;
  private smtp: Transporter | null = null;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private pairingManager: PairingManager | null = null;
  private subjectPrefix: string;

  constructor(opts: EmailTransportOptions) {
    this.opts = opts;
    this.subjectPrefix = opts.subjectPrefix ?? "[polymath]";
  }

  setPairingManager(pm: PairingManager): void {
    this.pairingManager = pm;
  }

  async start(): Promise<void> {
    // SMTP is stateless — just build the transporter.
    this.smtp = nodemailer.createTransport({
      host: this.opts.smtp.host,
      port: this.opts.smtp.port,
      secure: this.opts.smtp.secure ?? true,
      auth: { user: this.opts.smtp.user, pass: this.opts.smtp.pass },
    });

    // IMAP — connect, open INBOX, start listening.
    this.imap = new ImapFlow({
      host: this.opts.imap.host,
      port: this.opts.imap.port,
      secure: this.opts.imap.secure ?? true,
      auth: { user: this.opts.imap.user, pass: this.opts.imap.pass },
      logger: false,
    });

    await this.imap.connect();
    await this.imap.mailboxOpen("INBOX");
    this.running = true;

    // Attach IDLE notification handler — this fires whenever the mailbox grows.
    this.imap.on("exists", () => {
      void this.drainNewMessages().catch((err) => {
        console.error("[email] drain error:", err?.message ?? err);
      });
    });

    // Best-effort initial drain in case anything unread is sitting there.
    await this.drainNewMessages().catch(() => {});

    // Fallback poll loop — some providers drop IDLE silently. We'll poll every 30s
    // as a safety net; drainNewMessages is idempotent.
    const interval = this.opts.pollIntervalMs ?? 30_000;
    this.pollTimer = setInterval(() => {
      if (!this.running) return;
      void this.drainNewMessages().catch((err) => {
        console.error("[email] poll error:", err?.message ?? err);
      });
    }, interval);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    try { await this.imap?.logout(); } catch { /* ignore */ }
    this.imap = null;
    this.smtp?.close();
    this.smtp = null;
  }

  /**
   * Send a message to a session — sessionId is the sender's email address.
   * If there's a known In-Reply-To we could thread; for simplicity we just send
   * a fresh mail with the subject prefix.
   */
  async send(sessionId: string, text: string): Promise<void> {
    if (!this.smtp) throw new Error("email transport not started");
    const fromAddress = this.opts.smtp.from ?? this.opts.smtp.user;
    await this.smtp.sendMail({
      from: fromAddress,
      to: sessionId,
      subject: `${this.subjectPrefix} Re: your message`,
      text,
    });
  }

  private async drainNewMessages(): Promise<void> {
    if (!this.imap || !this.running) return;

    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      // Find every unseen message with our subject prefix.
      const uids = await this.imap.search({ seen: false }, { uid: true });
      if (!uids?.length) return;

      for (const uid of uids) {
        try {
          const msg = await this.imap.fetchOne(
            String(uid),
            { envelope: true, source: true, bodyParts: ["text"] },
            { uid: true },
          );
          if (!msg) continue;

          const subject = msg.envelope?.subject ?? "";
          const fromAddr = msg.envelope?.from?.[0]?.address ?? "";
          if (!fromAddr) continue;

          // Only respond to messages intended for the bot
          if (!subject.startsWith(this.subjectPrefix)) continue;

          const body = extractText(msg);
          if (!body.trim()) continue;

          // Mark as seen immediately so we don't double-process on reconnect
          await this.imap.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });

          // Pairing check
          if (this.pairingManager) {
            const status = this.pairingManager.checkSender(this.name, fromAddr);
            if (status === "unknown") {
              const code = this.pairingManager.createPairing(this.name, fromAddr);
              await this.sendReply(fromAddr, subject,
                `I need to verify you before processing mail. Your pairing code is: ${code}\n\n` +
                `The operator can approve with: polymath pairing approve email ${code}`,
              );
              continue;
            }
            if (status === "pending") {
              await this.sendReply(fromAddr, subject, "Your pairing is still pending approval.");
              continue;
            }
          }

          const response = await this.opts.onMessage({
            channel: this.name,
            senderId: fromAddr,
            text: body,
            sessionId: fromAddr,
          });

          await this.sendReply(fromAddr, subject, response);
        } catch (e: any) {
          console.error("[email] message handler error:", e?.message ?? e);
        }
      }
    } finally {
      lock.release();
    }
  }

  private async sendReply(to: string, originalSubject: string, text: string): Promise<void> {
    if (!this.smtp) return;
    const replySubject = originalSubject.toLowerCase().startsWith("re:")
      ? originalSubject
      : `Re: ${originalSubject}`;
    await this.smtp.sendMail({
      from: this.opts.smtp.from ?? this.opts.smtp.user,
      to,
      subject: replySubject,
      text,
    });
  }
}

function extractText(msg: { source?: Buffer; bodyParts?: Map<string, Buffer> | Record<string, Buffer> }): string {
  // imapflow returns bodyParts as a Map in newer versions
  const parts = msg.bodyParts;
  if (parts) {
    const getPart = (key: string): Buffer | undefined => {
      if (parts instanceof Map) return parts.get(key);
      return (parts as Record<string, Buffer>)[key];
    };
    const text = getPart("text");
    if (text) return text.toString("utf-8");
  }
  // Fall back to full source, strip headers roughly
  if (msg.source) {
    const src = msg.source.toString("utf-8");
    const splitAt = src.indexOf("\r\n\r\n");
    return splitAt >= 0 ? src.slice(splitAt + 4) : src;
  }
  return "";
}
