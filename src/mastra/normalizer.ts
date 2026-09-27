/**
 * Ingestion/normalizer: tail the honeypot JSONL and emit validated
 * AttackEvents. Malformed lines are skipped with a warning, never fatal.
 */
import { createReadStream, existsSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { AttackEventSchema, type AttackEvent } from "./schemas";

export const DEFAULT_LOG = "data/events.jsonl";

/** Parse a whole JSONL file into validated events. */
export async function readEvents(path = DEFAULT_LOG): Promise<AttackEvent[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const out: AttackEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = AttackEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
      else
        console.warn(
          `[normalizer] skipped malformed event: ${parsed.error.message}`,
        );
    } catch (err) {
      console.warn(
        `[normalizer] skipped unparseable line: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

/** Tail the log, invoking onEvent for each new line as it lands. */
export function tailEvents(
  path: string,
  onEvent: (e: AttackEvent) => void,
): () => void {
  const ANCHOR_BYTES = 64;
  let offset = 0;
  let partial = "";
  // The last few characters we consumed. A JSONL log is only ever appended to,
  // so those bytes must still be sitting at `offset` on the next poll. If they
  // are not, the file was rewritten or rotated in place -- and neither the size
  // nor the inode can see that case: a same-path rewrite keeps the inode, and a
  // replacement file is often LARGER than the old one, so `size < offset` is
  // false and a naive tail resumes mid-line and silently drops events.
  let anchor = "";

  const pump = async () => {
    if (!existsSync(path)) return;
    const text = await readFile(path, "utf8");
    // `offset` counts characters, not bytes: stat.size is bytes and diverges
    // from a string index as soon as a captured command contains non-ASCII
    // (an attacker password is exactly the kind of thing that happens), which
    // would slice mid-codepoint and corrupt every line after it.
    if (text.length < offset) {
      offset = 0;
      partial = "";
      anchor = "";
    }
    if (anchor && offset > 0) {
      const window = text.slice(Math.max(0, offset - anchor.length), offset);
      if (window !== anchor) {
        offset = 0;
        partial = "";
        anchor = "";
      }
    }
    if (text.length === offset) return;
    const chunk = text.slice(offset);
    offset = text.length;
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    anchor = text.slice(Math.max(0, offset - ANCHOR_BYTES));
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = AttackEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) onEvent(parsed.data);
      } catch (err) {
        console.warn(`[normalizer] skipped line: ${(err as Error).message}`);
      }
    }
  };

  const timer = setInterval(() => void pump(), 1000);
  void pump();
  return () => clearInterval(timer);
}
