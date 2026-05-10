import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { WebChatTransport } from "../src/transports/webchat.js";

describe("WebChatTransport", () => {
  it("registers GET /chat route on the Hono app", () => {
    const app = new Hono();
    const onMessage = vi.fn().mockResolvedValue("ok");

    new WebChatTransport({ app, onMessage });

    const routes = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes).toContainEqual("GET /chat");
  });

  it("GET /chat returns HTML", async () => {
    const app = new Hono();
    const onMessage = vi.fn().mockResolvedValue("ok");

    new WebChatTransport({ app, onMessage });

    const res = await app.request("/chat");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Polymath Chat");
    expect(body).toContain("ws/chat");
  });

  it("has name webchat", () => {
    const app = new Hono();
    const transport = new WebChatTransport({ app, onMessage: vi.fn() });
    expect(transport.name).toBe("webchat");
  });
});
