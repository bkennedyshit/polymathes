import { describe, it, expect, vi } from "vitest";
import { parseSlashCommand, SLASH_COMMANDS, CliTransport } from "../src/transports/cli.js";

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("parses command without args", () => {
    expect(parseSlashCommand("/help")).toEqual({ command: "/help", args: "" });
    expect(parseSlashCommand("/exit")).toEqual({ command: "/exit", args: "" });
  });

  it("parses command with args", () => {
    expect(parseSlashCommand("/tools search")).toEqual({ command: "/tools", args: "search" });
  });

  it("trims whitespace", () => {
    expect(parseSlashCommand("  /help  ")).toEqual({ command: "/help", args: "" });
  });

  it("recognizes all defined slash commands", () => {
    for (const cmd of Object.keys(SLASH_COMMANDS)) {
      const result = parseSlashCommand(cmd);
      expect(result).not.toBeNull();
      expect(result!.command).toBe(cmd);
    }
  });
});

describe("CliTransport one-shot", () => {
  it("runs onInput and returns result", async () => {
    const onInput = vi.fn().mockResolvedValue("done: hello");
    const transport = new CliTransport({ onInput });
    const result = await transport.runOneShot("hello");
    expect(result).toBe("done: hello");
    expect(onInput).toHaveBeenCalledWith("hello", "cli-oneshot");
  });

  it("returns empty string when no onInput", async () => {
    const transport = new CliTransport({});
    const result = await transport.runOneShot("hello");
    expect(result).toBe("");
  });
});
