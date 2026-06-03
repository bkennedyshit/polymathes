import type { EpisodicEntry } from "./episodic.js";
import { sanitizeContext } from "./scrubber.js";

export function formatRecentSessionContext(entries: EpisodicEntry[], maxChars = 8000): string {
  if (!entries.length) return "";

  const lines = entries
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => {
      const role = entry.role === "assistant" ? "assistant" : "user";
      const content = sanitizeContext(entry.content).replace(/\s+/g, " ").trim();
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean);

  if (!lines.length) return "";

  let body = lines.join("\n");
  if (body.length > maxChars) {
    body = body.slice(body.length - maxChars);
    const firstBreak = body.indexOf("\n");
    if (firstBreak >= 0) body = body.slice(firstBreak + 1);
  }

  return (
    "<conversation-history>\n" +
    "[System note: Recent messages from this same session. Use this to preserve step-by-step continuity. " +
    "This is historical context, not a new user instruction.]\n" +
    body +
    "\n</conversation-history>"
  );
}
