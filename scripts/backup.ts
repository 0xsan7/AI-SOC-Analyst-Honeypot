/**
 * Back up the campaign store.
 *
 * The store is LibSQL, so the `sqlite3` CLI is the wrong tool. VACUUM INTO
 * takes a consistent online copy -- the honeypot can keep writing while this
 * runs, and the result is a single valid file rather than a WAL plus a
 * half-written main db.
 *
 * Usage: npm run backup
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { closeStore, initStore } from "../src/mastra/store";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "backup";
const DB_URL = process.env.TURSO_DATABASE_URL ?? "file:./soc-analyst.db";

async function main() {
  // Remote LibSQL cannot be VACUUM INTO'd; a file-backed store can.
  if (!DB_URL.startsWith("file:")) {
    console.error(
      `[backup] ${DB_URL} is remote -- nothing to copy. Turso has its own ` +
        `point-in-time recovery and replication.`,
    );
    process.exit(1);
  }

  const source = DB_URL.replace(/^file:/, "");
  if (!existsSync(source)) {
    console.error(`[backup] no store at ${source} — run the pipeline first.`);
    process.exit(1);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const target = join(BACKUP_DIR, `soc-${stamp}.db`);

  // Open the source read-only-ish via the same driver the app uses, so the
  // copy sees the same journal state a live reader would.
  await initStore();
  const client = createClient({ url: DB_URL });
  try {
    await client.execute(`VACUUM INTO '${target}'`);
  } finally {
    client.close();
    await closeStore();
  }

  console.log(`[backup] wrote ${target}`);
}

await main();
