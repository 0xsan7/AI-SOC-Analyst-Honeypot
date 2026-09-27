/**
 * Campaign store. FR5: state persists via LibSQL, not memory-only, so
 * campaigns survive a restart.
 *
 * Correlation is deliberately deterministic and LLM-free: events from the same
 * source IP inside a time window join one campaign. That keeps the whole
 * correlation + reporting path usable on Gemini's 20 req/day free tier.
 */
import { createClient, type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { CampaignSchema, type Campaign, type EnrichedEvent } from "./schemas";

/** Events from one IP within this window collapse into a single campaign. */
export const CORRELATION_WINDOW_MS = Number(
  process.env.CAMPAIGN_WINDOW_MS ?? 30 * 60 * 1000,
);

/** FR6: report when severity >= 4 OR the campaign has >= 5 events. */
export const REPORT_SEVERITY = 4;
export const REPORT_EVENT_COUNT = 5;

/**
 * A campaign with no new events for this long is considered finished.
 *
 * 24h: long enough that a slow, periodic scanner keeps one campaign open across
 * its daily passes, and short enough that a resolved incident stops showing as
 * active within a day. Correlating against a closed campaign is not possible —
 * `findMatchingCampaign` only matches `status = 'open'` — so if a source really
 * is still active, the next event opens a fresh campaign rather than silently
 * reviving a closed one. That keeps history honest at the cost of splitting a
 * very long multi-day intrusion into successive campaigns.
 */
export const CAMPAIGN_IDLE_CLOSE_MS = Number(
  process.env.CAMPAIGN_IDLE_CLOSE_MS ?? 24 * 60 * 60 * 1000,
);

let client: Client | null = null;

/**
 * Single source of truth for the LibSQL connection, so the campaign store and
 * agent memory cannot drift onto different databases.
 */
export const DB_URL = process.env.TURSO_DATABASE_URL ?? "file:./soc-analyst.db";
export const DB_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN ?? undefined;

export function db(): Client {
  if (!client) {
    client = createClient({ url: DB_URL, authToken: DB_AUTH_TOKEN });
  }
  return client;
}

/** Close the handle so the underlying file can be moved or deleted. */
export function closeStore(): void {
  client?.close();
  client = null;
}

export async function initStore(): Promise<void> {
  await db().execute(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      firstSeen TEXT NOT NULL,
      lastSeen TEXT NOT NULL,
      sourceIps TEXT NOT NULL,
      eventIds TEXT NOT NULL,
      maxSeverity INTEGER NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      reportGenerated INTEGER NOT NULL DEFAULT 0
    )
  `);
  await db().execute(`
    CREATE TABLE IF NOT EXISTS enriched_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      campaignId TEXT,
      payload TEXT NOT NULL
    )
  `);
}

function rowToCampaign(row: Record<string, unknown>): Campaign {
  return CampaignSchema.parse({
    id: row.id as string,
    firstSeen: row.firstSeen as string,
    lastSeen: row.lastSeen as string,
    sourceIps: JSON.parse(row.sourceIps as string),
    eventIds: JSON.parse(row.eventIds as string),
    maxSeverity: row.maxSeverity as number,
    status: row.status as string,
    summary: (row.summary as string) ?? undefined,
  });
}

/**
 * Find an open campaign this event belongs to, or null.
 *
 * Matches on the campaign's *span* overlapping the event, not on lastSeen
 * alone. Filtering by `lastSeen >= since` silently failed for events that
 * arrive out of order (an older event against a newer campaign), which split a
 * single attacker's activity across many campaigns.
 */
export async function findMatchingCampaign(
  event: EnrichedEvent,
): Promise<Campaign | null> {
  const t = new Date(event.timestamp).getTime();
  const from = new Date(t - CORRELATION_WINDOW_MS).toISOString();
  const to = new Date(t + CORRELATION_WINDOW_MS).toISOString();
  const res = await db().execute({
    sql: "SELECT * FROM campaigns WHERE status = ? AND firstSeen <= ? AND lastSeen >= ? ORDER BY lastSeen DESC LIMIT 50",
    args: ["open", to, from],
  });
  for (const row of res.rows) {
    const c = rowToCampaign(row as Record<string, unknown>);
    if (c.sourceIps.includes(event.sourceIp)) return c;
  }
  return null;
}

export async function upsertCampaign(c: Campaign): Promise<void> {
  await db().execute({
    sql: `INSERT INTO campaigns (id, firstSeen, lastSeen, sourceIps, eventIds, maxSeverity, status, summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            lastSeen = excluded.lastSeen,
            sourceIps = excluded.sourceIps,
            eventIds = excluded.eventIds,
            maxSeverity = excluded.maxSeverity,
            status = excluded.status,
            summary = COALESCE(excluded.summary, campaigns.summary)`,
    args: [
      c.id,
      c.firstSeen,
      c.lastSeen,
      JSON.stringify(c.sourceIps),
      JSON.stringify(c.eventIds),
      c.maxSeverity,
      c.status,
      c.summary ?? null,
    ],
  });
}

/** Fold an enriched event into its campaign, opening one if none matches. */
export async function correlate(event: EnrichedEvent): Promise<Campaign> {
  const existing = await findMatchingCampaign(event);
  const campaign: Campaign = existing
    ? {
        ...existing,
        lastSeen:
          event.timestamp > existing.lastSeen
            ? event.timestamp
            : existing.lastSeen,
        sourceIps: existing.sourceIps.includes(event.sourceIp)
          ? existing.sourceIps
          : [...existing.sourceIps, event.sourceIp],
        eventIds: [...existing.eventIds, event.id],
        maxSeverity: Math.max(existing.maxSeverity, event.severity),
      }
    : {
        id: randomUUID(),
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        sourceIps: [event.sourceIp],
        eventIds: [event.id],
        maxSeverity: event.severity,
        status: "open",
      };

  await upsertCampaign(campaign);
  await db().execute({
    sql: "INSERT OR REPLACE INTO enriched_events (id, timestamp, campaignId, payload) VALUES (?, ?, ?, ?)",
    args: [event.id, event.timestamp, campaign.id, JSON.stringify(event)],
  });
  return campaign;
}

/**
 * Close campaigns that have gone quiet.
 *
 * Returns the ids it closed. `now` is injectable so the rule can be tested
 * without waiting a day. Idempotent: already-closed campaigns are untouched.
 */
export async function closeIdleCampaigns(
  now: Date = new Date(),
  idleMs: number = CAMPAIGN_IDLE_CLOSE_MS,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - idleMs).toISOString();
  const res = await db().execute({
    sql: "SELECT id FROM campaigns WHERE status = ? AND lastSeen < ?",
    args: ["open", cutoff],
  });
  const ids = res.rows.map((r) => String((r as Record<string, unknown>).id));
  if (ids.length === 0) return [];
  await db().execute({
    sql: `UPDATE campaigns SET status = ? WHERE status = ? AND lastSeen < ?`,
    args: ["closed", "open", cutoff],
  });
  return ids;
}

export async function listCampaigns(limit = 20): Promise<Campaign[]> {
  const res = await db().execute({
    sql: "SELECT * FROM campaigns ORDER BY lastSeen DESC LIMIT ?",
    args: [limit],
  });
  return res.rows.map((r) => rowToCampaign(r as Record<string, unknown>));
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const res = await db().execute({
    sql: "SELECT * FROM campaigns WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return rowToCampaign(res.rows[0] as Record<string, unknown>);
}

export async function getCampaignEvents(id: string): Promise<EnrichedEvent[]> {
  const res = await db().execute({
    sql: "SELECT payload FROM enriched_events WHERE campaignId = ? ORDER BY timestamp ASC",
    args: [id],
  });
  return res.rows.map(
    (r) =>
      JSON.parse(
        String((r as Record<string, unknown>).payload),
      ) as EnrichedEvent,
  );
}

/** FR6: true the first time a campaign crosses severity>=4 or >=5 events. */
export function shouldGenerateReport(c: Campaign): boolean {
  return (
    c.maxSeverity >= REPORT_SEVERITY || c.eventIds.length >= REPORT_EVENT_COUNT
  );
}

export async function markReportGenerated(id: string): Promise<void> {
  await db().execute({
    sql: "UPDATE campaigns SET reportGenerated = 1 WHERE id = ?",
    args: [id],
  });
}

export async function needsReport(c: Campaign): Promise<boolean> {
  if (!shouldGenerateReport(c)) return false;
  const res = await db().execute({
    sql: "SELECT reportGenerated FROM campaigns WHERE id = ?",
    args: [c.id],
  });
  return res.rows.length > 0 && Number(res.rows[0].reportGenerated) === 0;
}
