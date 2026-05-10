import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Context, Next } from "hono";

const AUTH_DIR = join(homedir(), ".polymath");
const AUTH_FILE = join(AUTH_DIR, "auth.key");

export function generateToken(): string {
  const token = randomBytes(32).toString("hex");
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, token, { mode: 0o600 });
  return token;
}

export function loadToken(): string | null {
  try {
    return readFileSync(AUTH_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

export function authMiddleware() {
  const token = loadToken();
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith("/api/") || path === "/health" || path === "/metrics") {
      return next();
    }
    if (!token) return c.json({ error: "no auth configured" }, 500);
    const header = c.req.header("authorization");
    if (header !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
