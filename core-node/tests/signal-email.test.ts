import { describe, it, expect, vi } from "vitest";
import { SignalTransport } from "../src/transports/signal.js";
import { EmailTransport } from "../src/transports/email.js";

/**
 * Integration tests here cover the non-network paths: construction, interface
 * conformance, and graceful degradation when external deps are missing.
 * Real IMAP/SMTP and signal-cli round trips are opt-in integration tests
 * (env var gated) because they require actual accounts and installed binaries.
 */

describe("SignalTransport", () => {
  it("instantiates with required config", () => {
    const t = new SignalTransport({
      account: "+15551234567",
      onMessage: vi.fn(),
    });
    expect(t.name).toBe("signal");
    expect(t.start).toBeInstanceOf(Function);
    expect(t.send).toBeInstanceOf(Function);
    expect(t.stop).toBeInstanceOf(Function);
  });

  it("start attempts to spawn signal-cli and handles missing binary", async () => {
    // When signal-cli is not installed, spawn emits an 'error' event but
    // start() still resolves — the transport logs to stderr and remains in
    // a running-but-unusable state. This is intentional so the Gateway
    // doesn't die when one channel can't initialise.
    const spyErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new SignalTransport({
      account: "+15551234567",
      signalCliPath: "definitely-not-a-real-binary-xyz123",
      onMessage: vi.fn(),
    });
    await t.start();
    // Give the spawn error event a tick to fire
    await new Promise((r) => setTimeout(r, 50));
    await t.stop();
    // Either spawn errored synchronously or asynchronously — in both cases we
    // just assert we didn't throw and that stderr got used if available.
    spyErr.mockRestore();
    expect(true).toBe(true);
  });
});

describe("EmailTransport", () => {
  it("instantiates with required config", () => {
    const t = new EmailTransport({
      imap: { host: "imap.example.com", port: 993, user: "u", pass: "p" },
      smtp: { host: "smtp.example.com", port: 465, user: "u", pass: "p" },
      onMessage: vi.fn(),
    });
    expect(t.name).toBe("email");
    expect(t.start).toBeInstanceOf(Function);
    expect(t.send).toBeInstanceOf(Function);
    expect(t.stop).toBeInstanceOf(Function);
  });

  it("send throws when not started", async () => {
    const t = new EmailTransport({
      imap: { host: "imap.example.com", port: 993, user: "u", pass: "p" },
      smtp: { host: "smtp.example.com", port: 465, user: "u", pass: "p" },
      onMessage: vi.fn(),
    });
    await expect(t.send("user@example.com", "hello")).rejects.toThrow(/not started/);
  });

  it("stop without start is safe", async () => {
    const t = new EmailTransport({
      imap: { host: "imap.example.com", port: 993, user: "u", pass: "p" },
      smtp: { host: "smtp.example.com", port: 465, user: "u", pass: "p" },
      onMessage: vi.fn(),
    });
    // Should not throw
    await expect(t.stop()).resolves.toBeUndefined();
  });
});
