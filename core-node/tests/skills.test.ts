import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRegistry } from "../src/skills/registry.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createSkill } from "../src/skills/mutate.js";

const TMP = join(tmpdir(), "polymath-skills-test-" + Date.now());

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function writeSkill(workspace: string, name: string, desc: string, body: string) {
  const dir = join(workspace, "skills", name);
  mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${desc}\ntags: [test, demo]\n---\n${body}\n`;
  const { writeFileSync } = require("node:fs");
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

describe("SkillRegistry", () => {
  it("discovers skills from workspace", () => {
    writeSkill(TMP, "summarize", "Summarize text", "You are a summarizer.");
    const sr = new SkillRegistry();
    sr.discover(TMP);
    expect(sr.list()).toHaveLength(1);
    expect(sr.get("summarize")?.description).toBe("Summarize text");
  });

  it("registers skills as tools in ToolRegistry", () => {
    writeSkill(TMP, "translate", "Translate text", "You translate.");
    const sr = new SkillRegistry();
    const tr = new ToolRegistry();
    sr.discover(TMP, tr);
    expect(tr.get("skill.translate")).toBeDefined();
  });

  it("list returns all discovered skills", () => {
    writeSkill(TMP, "a", "Skill A", "body a");
    writeSkill(TMP, "b", "Skill B", "body b");
    const sr = new SkillRegistry();
    sr.discover(TMP);
    const names = sr.list().map((s) => s.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });
});

describe("createSkill", () => {
  it("writes correct SKILL.md", () => {
    const file = createSkill(TMP, "writer", "Write content", "You are a writer.");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("name: writer");
    expect(content).toContain("description: Write content");
    expect(content).toContain("You are a writer.");
  });
});
