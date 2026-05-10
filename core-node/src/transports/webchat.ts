import type { Hono } from "hono";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { Transport } from "./base.js";

export interface WebChatTransportOptions {
  app: Hono;
  server?: Server;
  onMessage: (ctx: { channel: string; senderId: string; text: string; sessionId: string }) => Promise<string>;
}

const HTML_PAGE = `<!DOCTYPE html><html><head><title>Polymath Chat</title></head><body>
<div id="log" style="white-space:pre-wrap;height:80vh;overflow:auto;border:1px solid #ccc;padding:8px"></div>
<form id="f"><input id="i" style="width:80%" autocomplete="off"><button>Send</button></form>
<script>
const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/ws/chat');
const log=document.getElementById('log'),f=document.getElementById('f'),i=document.getElementById('i');
ws.onmessage=e=>{const d=JSON.parse(e.data);log.textContent+='Bot: '+d.text+'\\n';};
f.onsubmit=e=>{e.preventDefault();const t=i.value;if(!t)return;log.textContent+='You: '+t+'\\n';ws.send(JSON.stringify({text:t}));i.value='';};
</script></body></html>`;

export class WebChatTransport implements Transport {
  name = "webchat";
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, Set<WebSocket>>();
  private onMessage: WebChatTransportOptions["onMessage"];
  private server?: Server;

  constructor(opts: WebChatTransportOptions) {
    this.onMessage = opts.onMessage;
    this.server = opts.server;

    opts.app.get("/chat", (c) => c.html(HTML_PAGE));
  }

  async start(): Promise<void> {
    if (!this.server) return;
    this.wss = new WebSocketServer({ server: this.server, path: "/ws/chat" });
    this.wss.on("connection", (ws) => {
      const sessionId = "ws-" + Date.now();
      if (!this.clients.has(sessionId)) this.clients.set(sessionId, new Set());
      this.clients.get(sessionId)!.add(ws);

      ws.on("message", async (raw) => {
        try {
          const { text } = JSON.parse(String(raw));
          const response = await this.onMessage({ channel: "webchat", senderId: sessionId, text, sessionId });
          ws.send(JSON.stringify({ text: response }));
        } catch (e: any) {
          console.error("[webchat] ws message error:", e?.message ?? e);
        }
      });

      ws.on("close", () => {
        this.clients.get(sessionId)?.delete(ws);
      });
    });
  }

  async stop(): Promise<void> {
    this.wss?.close();
  }

  async send(sessionId: string, text: string): Promise<void> {
    const sockets = this.clients.get(sessionId);
    if (!sockets) return;
    const msg = JSON.stringify({ text });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}
