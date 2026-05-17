// Static registration of all builtin tool modules.
// Used when running as a bundled CJS where dynamic directory scans don't work.
import type { ToolRegistry } from "../registry.js";
import { register as registerCore } from "./core.js";
import { register as registerBrowser } from "./browser.js";
import { register as registerCodeExec } from "./code_exec.js";
import { register as registerComms } from "./comms.js";
import { register as registerCron } from "./cron.js";
import { register as registerFiles } from "./files.js";
import { register as registerGpu } from "./gpu.js";
import { register as registerInput } from "./input.js";
import { register as registerMedia } from "./media.js";
import { register as registerMemory } from "./memory.js";
import { register as registerProcesses } from "./processes.js";
import { register as registerSkills } from "./skills.js";
import { register as registerTerminal } from "./terminal.js";
import { register as registerVision } from "./vision.js";
import { register as registerVoice } from "./voice.js";
import { register as registerWeb } from "./web.js";

export function registerBuiltinTools(registry: ToolRegistry): void {
  registerCore(registry);
  registerBrowser(registry);
  registerCodeExec(registry);
  registerComms(registry);
  registerCron(registry);
  registerFiles(registry);
  registerGpu(registry);
  registerInput(registry);
  registerMedia(registry);
  registerMemory(registry);
  registerProcesses(registry);
  registerSkills(registry);
  registerTerminal(registry);
  registerVision(registry);
  registerVoice(registry);
  registerWeb(registry);
}
