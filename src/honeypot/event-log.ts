/**
 * Bounded event log.
 *
 * A public honeypot is scanned constantly, and the SSH listener records an
 * event per connection. Append-only, `data/events.jsonl` grows until the disk
 * fills — which on a small VPS means the pipeline, the database and the SSH
 * session you use to fix it all stop working at once.
 *
 * Rotates by size: when the file passes MAX_BYTES it is moved aside with a
 * timestamp suffix and a fresh one starts. Keeps MAX_FILES generations, so
 * total disk use is bounded at roughly MAX_BYTES * MAX_FILES regardless of
 * how much traffic arrives.
 *
 * Rotation is a rename, which the normalizer detects via its content anchor
 * (see src/mastra/normalizer.ts) — so a rotated log is re-read from the start
 * rather than silently skipping the gap.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join as joinPath } from "node:path";

const DEFAULT_MAX_BYTES = Number(process.env.LOG_MAX_BYTES ?? 50 * 1024 * 1024);
const DEFAULT_MAX_FILES = Number(process.env.LOG_MAX_FILES ?? 5);

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Append one event as JSONL, rotating if the file has grown past the cap.
 * Never throws: a logging failure must not take down capture.
 */
export function appendEvent(
  path: string,
  event: unknown,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path, maxBytes, maxFiles);
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  } catch (err) {
    console.error(`[log] could not write event: ${(err as Error).message}`);
  }
}

function rotateIfNeeded(path: string, maxBytes: number, maxFiles: number): void {
  if (!existsSync(path)) return;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return; // file vanished under us; just append
  }
  if (size < maxBytes) return;

  const rotated = `${path}.${stamp()}`;
  try {
    renameSync(path, rotated);
  } catch {
    return; // another process rotated first
  }

  // Drop the oldest generations. Must list the DIRECTORY, not the log path:
  // readdirSync on a file throws ENOTDIR, which readdirSafe swallows as [],
  // so passing `path` here silently disables pruning and the file count
  // grows without bound while total bytes look fine.
  const generations = readdirSafe(dirname(path))
    .filter((f) => f.startsWith(`${basename(path)}.`))
    .sort();
  while (generations.length > maxFiles) {
    const oldest = generations.shift();
    if (!oldest) break;
    try {
      unlinkSync(joinPath(dirname(path), oldest));
    } catch {
      /* already gone */
    }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
