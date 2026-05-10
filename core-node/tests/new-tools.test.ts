import { describe, it, expect, vi, afterAll, beforeAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { rm, writeFile, readFile, mkdir } from "node:fs/promises";
import http from "node:http";
import { ToolRegistry } from "../src/tools/registry.js";
import { register as registerTerminal } from "../src/tools/builtin/terminal.js";
import { register as registerFiles } from "../src/tools/builtin/files.js";
import { register as registerProcesses } from "../src/tools/builtin/processes.js";
import { register as registerWeb, setWebConfig } from "../src/tools/builtin/web.js";
import { register as registerComms, setSubagentSpawner } from "../src/tools/builtin/comms.js";
import { register as registerCron, setScheduler } from "../src/tools/builtin/cron.js";
import { register as registerMemory, setMemoryBackend } from "../src/tools/builtin/memory.js";
import { GoogleAdapter } from "../src/llm/google.js";
import type { ChatMessage, LlmTool, ChatDelta } from "../src/llm/types.js";

const testDir = join(tmpdir(), `polymath-new-tools-${randomBytes(4).toString("hex")}`);

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const results: ChatDelta[] = [];
  for await (const d of iter) results.push(d);
  return results;
}

// --- Task 15: shell_run_streaming ---
describe("shell_run_streaming", () => {
  it("streams output lines", async () => {
    const reg = new ToolRegistry();
    registerTerminal(reg);
    const tool = reg.get("shell_run_streaming")!;
    const result = (await tool.handler({ command: "echo line1 && echo line2" }, null)) as any;
    expect(result.exitCode).toBe(0);
    expect(result.lines.length).toBeGreaterThanOrEqual(2);
    expect(result.lines.join("\n")).toContain("line1");
    expect(result.lines.join("\n")).toContain("line2");
  });
});

// --- Task 16: fs_move and fs_edit unified diff ---
describe("fs_move", () => {
  it("moves a file", async () => {
    const reg = new ToolRegistry();
    registerFiles(reg);
    const src = join(testDir, "move_src.txt");
    const dest = join(testDir, "subdir", "move_dest.txt");
    const write = reg.get("fs_write")!;
    const move = reg.get("fs_move")!;
    const read = reg.get("fs_read")!;

    await write.handler({ path: src, content: "moveme" }, null);
    const result = (await move.handler({ src, dest }, null)) as any;
    expect(result.ok).toBe(true);
    const content = (await read.handler({ path: dest }, null)) as any;
    expect(content.content).toBe("moveme");
  });
});

describe("fs_edit unified diff", () => {
  it("applies a unified diff", async () => {
    const reg = new ToolRegistry();
    registerFiles(reg);
    const filePath = join(testDir, "diff_test.txt");
    const write = reg.get("fs_write")!;
    const edit = reg.get("fs_edit")!;
    const read = reg.get("fs_read")!;

    await write.handler({ path: filePath, content: "line1\nline2\nline3\nline4" }, null);
    const diff = `--- a/file.txt\n+++ b/file.txt\n@@ -2,2 +2,2 @@\n-line2\n+LINE2_MODIFIED`;
    const result = (await edit.handler({ path: filePath, old_str: diff, new_str: "" }, null)) as any;
    expect(result.ok).toBe(true);
    const content = (await read.handler({ path: filePath }, null)) as any;
    expect(content.content).toContain("LINE2_MODIFIED");
    expect(content.content).not.toContain("line2");
  });
});

// --- Task 17: proc_spawn and proc_wait ---
describe("proc_spawn", () => {
  it("spawns a detached process and returns pid", async () => {
    const reg = new ToolRegistry();
    registerProcesses(reg);
    const tool = reg.get("proc_spawn")!;
    const isWin = process.platform === "win32";
    const cmd = isWin ? "cmd.exe" : "sleep";
    const args = isWin ? ["/c", "timeout /t 2 /nobreak >nul"] : ["2"];
    const result = (await tool.handler({ command: cmd, args }, null)) as any;
    expect(result.pid).toBeTypeOf("number");
    // Clean up
    try { process.kill(result.pid); } catch {}
  });
});

describe("proc_wait", () => {
  it("waits for process to exit", async () => {
    const reg = new ToolRegistry();
    registerProcesses(reg);
    const spawn = reg.get("proc_spawn")!;
    const wait = reg.get("proc_wait")!;
    const isWin = process.platform === "win32";
    const cmd = isWin ? "cmd.exe" : "true";
    const args = isWin ? ["/c", "echo done"] : [];
    const { pid } = (await spawn.handler({ command: cmd, args }, null)) as any;
    // Give it a moment to finish
    await new Promise((r) => setTimeout(r, 500));
    const result = (await wait.handler({ pid, timeout: 5000 }, null)) as any;
    expect(result.exitCode).toBe(0);
  });
});

// --- Task 18: web tools ---
describe("web_fetch_full", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Hello</h1></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns raw HTML", async () => {
    const reg = new ToolRegistry();
    registerWeb(reg);
    const tool = reg.get("web_fetch_full")!;
    const result = (await tool.handler({ url: `http://127.0.0.1:${port}` }, null)) as any;
    expect(result.html).toContain("<h1>Hello</h1>");
    expect(result.status).toBe(200);
  });
});

describe("web_search with config", () => {
  it("uses DuckDuckGo fallback when no keys set", async () => {
    const reg = new ToolRegistry();
    setWebConfig({});
    registerWeb(reg);
    const tool = reg.get("web_search")!;
    // Just verify it doesn't throw "not configured" anymore
    const result = (await tool.handler({ query: "test" }, null)) as any;
    // It will either return results or an error from network, but not "not configured"
    expect(result.error ?? "").not.toContain("not configured");
  });
});

// --- Task 21: channel_send and sessions_spawn ---
describe("channel_send", () => {
  it("returns error when no transport hub connected", async () => {
    const reg = new ToolRegistry();
    registerComms(reg);
    const tool = reg.get("channel_send")!;
    const result = (await tool.handler({ channel: "telegram", target: "123", text: "hi" }, null)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("transport hub not connected");
  });

  it("routes to connected transport hub", async () => {
    const reg = new ToolRegistry();
    const { setTransportHub } = await import("../src/tools/builtin/comms.js");
    const sendSpy = vi.fn().mockResolvedValue({ ok: true });
    setTransportHub({
      list: () => [{ name: "telegram" }],
      send: sendSpy,
    });
    registerComms(reg);
    const tool = reg.get("channel_send")!;
    const result = (await tool.handler({ channel: "telegram", target: "123", text: "hi" }, null)) as any;
    expect(result.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("telegram", "123", "hi");
    // Reset for other tests
    setTransportHub(undefined as any);
  });
});

describe("sessions_spawn with spawner", () => {
  it("calls the subagent spawner when set", async () => {
    const reg = new ToolRegistry();
    const mockSpawner = vi.fn().mockResolvedValue({ id: "sub1", status: "done" });
    setSubagentSpawner(mockSpawner);
    registerComms(reg);
    const tool = reg.get("sessions_spawn")!;
    const result = (await tool.handler({ task: "do something" }, null)) as any;
    expect(mockSpawner).toHaveBeenCalledWith("do something", { toolset: undefined, timeoutMs: undefined });
    expect(result.ok).toBe(true);
    expect(result.result.id).toBe("sub1");
    // Reset
    setSubagentSpawner(undefined as any);
  });
});

// --- Task 22: cron_trigger_now, cron_enable, cron_disable ---
describe("cron tools", () => {
  it("registers trigger_now, enable, disable", () => {
    const reg = new ToolRegistry();
    registerCron(reg);
    expect(reg.get("cron_trigger_now")).toBeDefined();
    expect(reg.get("cron_enable")).toBeDefined();
    expect(reg.get("cron_disable")).toBeDefined();
  });
});

// --- Task 23: memory tools ---
describe("memory tools", () => {
  it("registers all memory tools", () => {
    const reg = new ToolRegistry();
    registerMemory(reg);
    expect(reg.get("memory_recall")).toBeDefined();
    expect(reg.get("memory_recall_session")).toBeDefined();
    expect(reg.get("memory_recall_by_date")).toBeDefined();
    expect(reg.get("memory_pin")).toBeDefined();
    expect(reg.get("memory_forget")).toBeDefined();
    expect(reg.get("memory_list_sessions")).toBeDefined();
  });

  it("memory_recall returns empty when no backend", async () => {
    const reg = new ToolRegistry();
    registerMemory(reg);
    const tool = reg.get("memory_recall")!;
    const result = (await tool.handler({ query: "test" }, null)) as any;
    expect(result.results).toEqual([]);
  });
});

// --- Task 34: GoogleAdapter ---
describe("GoogleAdapter", () => {
  let server: http.Server;
  let port: number;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams text content", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } })}\n\n`);
      res.end();
    };

    // Monkey-patch the URL by subclassing
    const adapter = new GoogleAdapter({ api_key: "k", model: "gemini-pro" });
    // Override fetch for this test
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const newUrl = url.replace("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent", `http://127.0.0.1:${port}/stream`);
      return origFetch(newUrl.includes("127.0.0.1") ? newUrl : `http://127.0.0.1:${port}/stream`, init);
    };

    try {
      const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
      const deltas = await collect(adapter.complete(msgs, []));
      expect(deltas.some((d) => d.content === "hello")).toBe(true);
      expect(deltas.some((d) => d.usage?.prompt_tokens === 5)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("handles function calls", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "NYC" } } }] }, finishReason: "STOP" }] })}\n\n`);
      res.end();
    };

    const adapter = new GoogleAdapter({ api_key: "k", model: "gemini-pro" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_input: any, init?: any) => origFetch(`http://127.0.0.1:${port}/stream`, init);

    try {
      const msgs: ChatMessage[] = [{ role: "user", content: "weather?" }];
      const tools: LlmTool[] = [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: {} } }];
      const deltas = await collect(adapter.complete(msgs, tools));
      const tcDelta = deltas.find((d) => d.tool_calls?.length);
      expect(tcDelta).toBeDefined();
      expect(tcDelta!.tool_calls![0].function.name).toBe("get_weather");
      expect(JSON.parse(tcDelta!.tool_calls![0].function.arguments)).toEqual({ city: "NYC" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("converts tool role messages to functionResponse", async () => {
    handler = (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        // Verify the tool message was converted to functionResponse
        const hasResponse = parsed.contents.some((c: any) =>
          c.parts.some((p: any) => p.functionResponse)
        );
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: hasResponse ? "yes" : "no" }] }, finishReason: "STOP" }] })}\n\n`);
        res.end();
      });
    };

    const adapter = new GoogleAdapter({ api_key: "k", model: "gemini-pro" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_input: any, init?: any) => origFetch(`http://127.0.0.1:${port}/stream`, init);

    try {
      const msgs: ChatMessage[] = [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }] },
        { role: "tool", content: '{"temp":72}', tool_call_id: "c1", name: "get_weather" },
      ];
      const deltas = await collect(adapter.complete(msgs, []));
      expect(deltas.some((d) => d.content === "yes")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
