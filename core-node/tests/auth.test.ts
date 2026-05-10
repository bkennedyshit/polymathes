import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateToken, loadToken, authMiddleware } from "../src/gateway/auth.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Hono } from "hono";

const AUTH_FILE = join(homedir(), ".polymath", "auth.key");

describe("auth", () => {
  let originalToken: string | null = null;

  beforeEach(() => {
    originalToken = loadToken();
  });

  afterEach(() => {
    // Restore original token if it existed
    if (originalToken) {
      const { writeFileSync } = require("node:fs");
      writeFileSync(AUTH_FILE, originalToken, { mode: 0o600 });
    }
  });

  it("generateToken creates 64-char hex string", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  it("loadToken reads back generated token", () => {
    const token = generateToken();
    expect(loadToken()).toBe(token);
  });

  it("authMiddleware skips /health", async () => {
    generateToken();
    const app = new Hono();
    app.use("*", authMiddleware());
    app.get("/health", (c) => c.text("ok"));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("authMiddleware rejects missing token on /api/*", async () => {
    generateToken();
    const app = new Hono();
    app.use("*", authMiddleware());
    app.get("/api/test", (c) => c.text("ok"));
    const res = await app.request("/api/test");
    expect(res.status).toBe(401);
  });

  it("authMiddleware allows valid token on /api/*", async () => {
    const token = generateToken();
    const app = new Hono();
    app.use("*", authMiddleware());
    app.get("/api/test", (c) => c.text("ok"));
    const res = await app.request("/api/test", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
