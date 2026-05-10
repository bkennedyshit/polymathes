import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { register as registerMedia } from "../src/tools/builtin/media.js";
import { register as registerVision } from "../src/tools/builtin/vision.js";
import { register as registerVoice } from "../src/tools/builtin/voice.js";
import { register as registerCodeExec } from "../src/tools/builtin/code_exec.js";
import { register as registerInput } from "../src/tools/builtin/input.js";
import { execFileSync } from "node:child_process";

describe("media tools", () => {
  it("registers all media tools with check_fn returning false", () => {
    const reg = new ToolRegistry();
    registerMedia(reg);
    expect(reg.get("media_index")).toBeDefined();
    expect(reg.get("media_search")).toBeDefined();
    expect(reg.get("media_search_by_image")).toBeDefined();
    expect(reg.get("media_describe")).toBeDefined();
    // check_fn false means list() hides them
    expect(reg.list({ toolset: "media" })).toHaveLength(0);
  });

  it("stubs return expected message", async () => {
    const reg = new ToolRegistry();
    registerMedia(reg);
    const result = (await reg.get("media_index")!.handler({ path: "/tmp/x" }, null)) as any;
    expect(result.error).toContain("media-memory MCP server not connected");
  });
});

describe("vision tools", () => {
  it("registers and returns stub message", async () => {
    const reg = new ToolRegistry();
    registerVision(reg);
    expect(reg.list({ toolset: "vision" })).toHaveLength(3);
    const result = (await reg.get("image_describe")!.handler({ path: "/img.png" }, null)) as any;
    expect(result.error).toBe("vision model not configured");
  });
});

describe("voice tools", () => {
  it("registers and returns stub messages", async () => {
    const reg = new ToolRegistry();
    registerVoice(reg);
    expect(reg.list({ toolset: "voice" })).toHaveLength(2);
    const tts = (await reg.get("tts")!.handler({ text: "hi" }, null)) as any;
    expect(tts.error).toBe("TTS not configured");
    const stt = (await reg.get("stt")!.handler({ audio_path: "/a.wav" }, null)) as any;
    expect(stt.error).toBe("STT not configured");
  });
});

describe("input tools", () => {
  it("registers with check_fn returning false", () => {
    const reg = new ToolRegistry();
    registerInput(reg);
    expect(reg.get("input_move")).toBeDefined();
    expect(reg.get("input_click")).toBeDefined();
    expect(reg.get("input_type")).toBeDefined();
    expect(reg.get("input_hotkey")).toBeDefined();
    expect(reg.list({ toolset: "input" })).toHaveLength(0);
  });
});

describe("execute_code", () => {
  it("executes javascript and returns output", async () => {
    const reg = new ToolRegistry();
    registerCodeExec(reg);
    const tool = reg.get("execute_code")!;
    const result = (await tool.handler({ language: "javascript", source: 'console.log("hello polymath")' }, null)) as any;
    expect(result.stdout.trim()).toBe("hello polymath");
    expect(result.code).toBe(0);
  });

  const hasPython = (() => {
    try {
      const cmd = process.platform === "win32" ? "python" : "python3";
      execFileSync(cmd, ["--version"]);
      return true;
    } catch { return false; }
  })();

  it.skipIf(!hasPython)("executes python and returns output", async () => {
    const reg = new ToolRegistry();
    registerCodeExec(reg);
    const tool = reg.get("execute_code")!;
    const result = (await tool.handler({ language: "python", source: 'print("hello python")' }, null)) as any;
    expect(result.stdout.trim()).toBe("hello python");
    expect(result.code).toBe(0);
  });

  it("returns error for unsupported language", async () => {
    const reg = new ToolRegistry();
    registerCodeExec(reg);
    const tool = reg.get("execute_code")!;
    const result = (await tool.handler({ language: "ruby", source: 'puts "hi"' }, null)) as any;
    expect(result.error).toContain("language not supported");
  });
});
