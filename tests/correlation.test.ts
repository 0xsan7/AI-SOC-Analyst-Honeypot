/**
 * Correlation + reporting tests. No LLM, no network — the store runs against a
 * throwaway file DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'soc-test-'));
  process.env.TURSO_DATABASE_URL = `file:${join(dir, 'test.db')}`;
  // The store memoizes its client, so this module must be re-imported per test.
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TURSO_DATABASE_URL;
});

/** Re-import the store so its memoized client picks up the new DB path. */
async function freshStore() {
  const prev = storeModule;
  prev?.closeStore();
  vi.resetModules();
  storeModule = await import('../src/mastra/store');
  return storeModule;
}

let storeModule: typeof import('../src/mastra/store') | null = null;

function event(sourceIp: string, minutesAgo: number, severity = 3) {
  return {
    id: `${sourceIp}-${minutesAgo}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sourceIp,
    service: 'ssh' as const,
    usernameTried: 'root',
    passwordTried: 'toor',
    commandsAttempted: ['whoami'],
    sessionDurationMs: 100,
    raw: {},
    classification: 'recon' as const,
    severity,
    reasoning: 'test',
  };
}

describe('correlation (acceptance criterion: one IP in a window = one campaign)', () => {
  it('groups events from the same IP inside the window into one campaign', async () => {
    const store = await freshStore();
    await store.initStore();
    let campaignId = '';
    for (const m of [29, 27, 24, 19, 12, 4]) {
      const c = await store.correlate(event('198.51.100.23', m, 3));
      campaignId = c.id;
    }
    const campaigns = await store.listCampaigns();
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].eventIds).toHaveLength(6);
  });

  it('keeps different IPs in separate campaigns', async () => {
    const store = await freshStore();
    await store.initStore();
    await store.correlate(event('198.51.100.23', 10));
    await store.correlate(event('203.0.113.90', 9));
    const campaigns = await store.listCampaigns();
    expect(campaigns).toHaveLength(2);
  });

  it('starts a new campaign when the same IP returns outside the window', async () => {
    const store = await freshStore();
    await store.initStore();
    await store.correlate(event('198.51.100.23', 10));
    await store.correlate(event('198.51.100.23', 200));
    expect(await store.listCampaigns()).toHaveLength(2);
  });

  it('keeps the maximum severity across merged events', async () => {
    const store = await freshStore();
    await store.initStore();
    await store.correlate(event('198.51.100.23', 20, 2));
    const c = await store.correlate(event('198.51.100.23', 15, 5));
    expect(c.maxSeverity).toBe(5);
  });
});

describe('report threshold (FR6)', () => {
  it('triggers on severity >= 4', async () => {
    const store = await freshStore();
    await store.initStore();
    const c = await store.correlate(event('198.51.100.23', 10, 4));
    expect(store.shouldGenerateReport(c)).toBe(true);
  });

  it('triggers on >= 5 events even at low severity', async () => {
    const store = await freshStore();
    await store.initStore();
    let c;
    for (const m of [29, 27, 24, 21, 18]) {
      c = await store.correlate(event('198.51.100.23', m, 2));
    }
    expect(store.shouldGenerateReport(c!)).toBe(true);
  });

  it('does not trigger below both thresholds', async () => {
    const store = await freshStore();
    await store.initStore();
    const c = await store.correlate(event('203.0.113.90', 10, 2));
    expect(store.shouldGenerateReport(c)).toBe(false);
  });

  it('only reports once per campaign', async () => {
    const store = await freshStore();
    await store.initStore();
    const c = await store.correlate(event('198.51.100.23', 10, 5));
    expect(await store.needsReport(c)).toBe(true);
    await store.markReportGenerated(c.id);
    expect(await store.needsReport(c)).toBe(false);
  });
});
