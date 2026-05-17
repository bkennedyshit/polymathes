/**
 * Streaming context scrubber — strips `<memory-context>...</memory-context>`
 * blocks from model output.
 *
 * Two purposes:
 *   1. Prevents prompt-injection via recalled memory: if a prior user
 *      message contained adversarial text and got prefetched as context,
 *      we don't want the model echoing those tags back to the UI where
 *      they could be re-interpreted on the next turn.
 *   2. Cleans up rare cases where the model itself echoes its memory
 *      context block back into the assistant message.
 *
 * Two flavors:
 *   - sanitizeContext(text)         — one-shot for completed strings
 *   - StreamingContextScrubber       — stateful for SSE deltas (handles
 *                                      tags split across chunks)
 */

const OPEN_TAG = "<memory-context>";
const CLOSE_TAG = "</memory-context>";
// Match either case, with optional whitespace inside the tag braces.
const FENCE_TAG_RE = /<\/?\s*memory-context\s*>/gi;
const INTERNAL_BLOCK_RE = /<\s*memory-context\s*>[\s\S]*?<\/\s*memory-context\s*>/gi;
const SYSTEM_NOTE_RE =
  /\[System note:\s*The following is recalled memory context,\s*NOT new user input\.[\s\S]*?\]\s*/gi;

/**
 * Strip the memory-context block(s) and any system-note line from a
 * completed string. Safe to call on partial text — won't crash on
 * unbalanced tags, but won't be smart about them either (use the
 * streaming scrubber for that case).
 */
export function sanitizeContext(text: string): string {
  if (!text) return "";
  let out = text;
  out = out.replace(INTERNAL_BLOCK_RE, "");
  out = out.replace(SYSTEM_NOTE_RE, "");
  out = out.replace(FENCE_TAG_RE, "");
  return out;
}

/**
 * Stateful scrubber for streaming output. Holds back partial-tag fragments
 * across deltas so a tag opened in one chunk and closed in another doesn't
 * leak its payload to the UI.
 *
 * Usage:
 *   const s = new StreamingContextScrubber();
 *   for await (const delta of stream) {
 *     const visible = s.feed(delta);
 *     if (visible) emit(visible);
 *   }
 *   const tail = s.flush();
 *   if (tail) emit(tail);
 *
 * For a fresh turn, create a new instance OR call reset().
 */
export class StreamingContextScrubber {
  private inSpan = false;
  private buf = "";

  reset(): void {
    this.inSpan = false;
    this.buf = "";
  }

  /**
   * Process a delta and return the safe-to-emit prefix. Any trailing
   * fragment that could be the start of an open/close tag is held back
   * in the internal buffer for the next call or for flush().
   */
  feed(text: string): string {
    if (!text) return "";

    let buf = this.buf + text;
    this.buf = "";
    const out: string[] = [];

    while (buf.length > 0) {
      const lower = buf.toLowerCase();

      if (this.inSpan) {
        const closeIdx = lower.indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          // No close yet. Hold back any suffix that could be a partial
          // close tag. Drop the rest (it's inside a span).
          const partial = this.maxPartialSuffix(lower, CLOSE_TAG);
          this.buf = partial > 0 ? buf.slice(buf.length - partial) : "";
          return out.join("");
        }
        // Found close — discard span body + tag, continue.
        buf = buf.slice(closeIdx + CLOSE_TAG.length);
        this.inSpan = false;
        continue;
      }

      const openIdx = lower.indexOf(OPEN_TAG);
      if (openIdx === -1) {
        // No open tag in buffer. Hold back any suffix that could start
        // an open tag, emit the rest.
        const partial = this.maxPartialSuffix(lower, OPEN_TAG);
        if (partial > 0) {
          out.push(buf.slice(0, buf.length - partial));
          this.buf = buf.slice(buf.length - partial);
        } else {
          out.push(buf);
        }
        return out.join("");
      }

      // Emit text before the open tag, enter span.
      if (openIdx > 0) out.push(buf.slice(0, openIdx));
      buf = buf.slice(openIdx + OPEN_TAG.length);
      this.inSpan = true;
    }

    return out.join("");
  }

  /**
   * Emit any held-back buffer at end of stream. If we're stuck inside an
   * unterminated span, discard the remainder (safer to truncate than
   * leak partial memory context).
   */
  flush(): string {
    if (this.inSpan) {
      this.buf = "";
      this.inSpan = false;
      return "";
    }
    const tail = this.buf;
    this.buf = "";
    return tail;
  }

  /**
   * Length of the longest suffix of `buf` that could be a prefix of `tag`.
   * Lets us hold back exactly enough characters to handle a tag split
   * across chunks without leaking text that's definitely outside any tag.
   */
  private maxPartialSuffix(buf: string, tag: string): number {
    const max = Math.min(buf.length, tag.length - 1);
    for (let i = max; i > 0; i--) {
      if (tag.startsWith(buf.slice(buf.length - i))) return i;
    }
    return 0;
  }
}
