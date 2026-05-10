import type { LlmTool } from "../llm/types.js";

export interface SystemPromptOpts {
  soul?: string;
  tools: LlmTool[];
  policyHints?: string[];
}

export function buildSystemPrompt(opts: SystemPromptOpts): string {
  const sections: string[] = [];

  if (opts.soul) {
    sections.push(opts.soul);
  }

  if (opts.tools.length) {
    const toolLines = opts.tools.map((t) => {
      const params = JSON.stringify(t.function.parameters);
      return `- ${t.function.name}: ${t.function.description} | params: ${params}`;
    });
    sections.push("## Tools\n" + toolLines.join("\n"));
  }

  if (opts.policyHints?.length) {
    sections.push("## Policy\n" + opts.policyHints.map((h) => `- ${h}`).join("\n"));
  }

  sections.push(
    "## Rules\n" +
      "- Use tools to accomplish tasks.\n" +
      "- Call core.final_answer with your result when done.\n" +
      "- Never repeat the same tool call with identical arguments.",
  );

  return sections.join("\n\n");
}
