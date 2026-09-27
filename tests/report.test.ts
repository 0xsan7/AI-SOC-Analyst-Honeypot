/**
 * Report rendering, including the degenerate shapes nothing else covers: a
 * campaign with exactly one event, and one with no events at all.
 *
 * renderReport is pure, so these need no store and no filesystem.
 */
import { describe, it, expect } from "vitest";
import { renderReport } from "../src/mastra/report";
import type { Campaign, EnrichedEvent } from "../src/mastra/schemas";

const ts = "2026-09-26T22:00:00.000Z";

function event(over: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    id: "evt-1",
    timestamp: ts,
    sourceIp: "198.51.100.23",
    sourcePort: 40001,
    service: "ssh",
    usernameTried: "root",
    passwordTried: "hunter2",
    commandsAttempted: ["uname -a"],
    sessionDurationMs: 1200,
    raw: {},
    classification: "credential_stuffing",
    severity: 2,
    reasoning: "default credential",
    ...over,
  };
}

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "camp-1",
    firstSeen: ts,
    lastSeen: ts,
    sourceIps: ["198.51.100.23"],
    eventIds: ["evt-1"],
    maxSeverity: 2,
    status: "open",
    ...over,
  };
}

describe("renderReport — single event", () => {
  const md = renderReport(campaign(), [event()]);

  it("agrees in number rather than saying '1 sessions ... were'", () => {
    expect(md).toContain("1 SSH session was recorded");
    expect(md).not.toContain("1 SSH session was recorded against the honeypot from 1 source addresses");
  });

  it("uses the singular for a single source address", () => {
    expect(md).toContain("1 source address");
  });

  it("still renders the required sections", () => {
    expect(md).toContain("## Summary");
    expect(md).toContain("## In plain language");
    expect(md).toContain("**Severity:**");
    expect(md).toContain("**Status:** open");
  });
});

describe("renderReport — plural forms", () => {
  const many = renderReport(
    campaign({ eventIds: ["a", "b"], maxSeverity: 5 }),
    [event({ id: "a" }), event({ id: "b", sourceIp: "198.51.100.24" })],
  );

  it("uses plural for multiple sessions and addresses", () => {
    expect(many).toMatch(/\d+ SSH sessions were recorded/);
  });

  it("reflects a closed campaign", () => {
    expect(renderReport(campaign({ status: "closed" }), [event()])).toContain("**Status:** closed");
  });
});

describe("renderReport — no events", () => {
  it("does not throw on an empty event list", () => {
    expect(() => renderReport(campaign({ eventIds: [] }), [])).not.toThrow();
  });
});
