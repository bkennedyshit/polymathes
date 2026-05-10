import { z } from "zod";
import type { ToolRegistry } from "../registry.js";

const MSG = "vision model not configured";

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "image_describe",
    description: "Describe an image using a vision model",
    parameters: z.object({ path: z.string() }),
    async handler() { return { error: MSG }; },
    toolset: "vision",
  });

  registry.register({
    name: "image_ocr",
    description: "Extract text from an image via OCR",
    parameters: z.object({ path: z.string() }),
    async handler() { return { error: MSG }; },
    toolset: "vision",
  });

  registry.register({
    name: "image_generate",
    description: "Generate an image from a text prompt",
    parameters: z.object({ prompt: z.string() }),
    async handler() { return { error: MSG }; },
    toolset: "vision",
  });
}
