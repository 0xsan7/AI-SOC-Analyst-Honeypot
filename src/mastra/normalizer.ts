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
  let offset = 0;
  let partial = "";

  const pump = async () => {
    if (!existsSync(path)) return;
    const stat = await import("node:fs").then((fs) => fs.statSync(path));
    if (stat.size < offset) {
      // Truncated/rotated — restart from the top.
      offset = 0;
      partial = "";
    }
    if (stat.size === offset) return;
    const chunk = await readFile(path, "utf8").then((t) => t.slice(offset));
    offset = stat.size;
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
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
