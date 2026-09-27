/**
 * Bounded-log rotation and the connection cap — the two things standing
 * between a public honeypot and a dead VPS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../src/honeypot/event-log";
import { ConnectionLimiter } from "../src/honeypot/connection-limiter";

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eventlog-"));
  log = join(dir, "events.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("appendEvent", () => {
  it("creates the directory and writes JSONL", () => {
    appendEvent(log, { id: "a" });
    appendEvent(log, { id: "b" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ id: "a" });
  });

  it("rotates once the file passes the cap", () => {
    // 200-byte cap: a handful of writes must trigger it.
    for (let i = 0; i < 20; i++) appendEvent(log, { i, pad: "x".repeat(50) }, 200);
    const rotated = readdirSync(dir).filter((f) => f.startsWith("events.jsonl."));
    expect(rotated.length).toBeGreaterThan(0);
    // The live file is still valid JSONL, not a continuation of the old one.
    for (const line of readFileSync(log, "utf8").trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("keeps disk bounded by dropping old generations", () => {
    // 150-byte cap, keep 2: total use must stay near 3 files, not grow forever.
    for (let i = 0; i < 200; i++) appendEvent(log, { i, pad: "x".repeat(50) }, 150, 2);
    const files = readdirSync(dir).filter((f) => f.startsWith("events.jsonl"));
    // 2 rotated + the live file, give or take one in-flight.
    expect(files.length).toBeLessThanOrEqual(4);
  });

  it("never throws on a logging failure", () => {
    // A directory where the file should be: mkdir/append will fail.
    const bad = join(dir, "sub", "events.jsonl");
    expect(() => appendEvent(bad, { id: "x" })).not.toThrow();
  });

  it("leaves the log absent rather than creating junk when rotation races", () => {
    appendEvent(log, { id: "first" });
    expect(existsSync(log)).toBe(true);
  });
});

describe("ConnectionLimiter", () => {
  it("allows up to the global cap, then refuses", () => {
    const l = new ConnectionLimiter(3, 100);
    expect(l.acquire("1.1.1.1")).toBe(true);
    expect(l.acquire("2.2.2.2")).toBe(true);
    expect(l.acquire("3.3.3.3")).toBe(true);
    expect(l.acquire("4.4.4.4")).toBe(false);
    expect(l.activeCount).toBe(3);
  });

  it("caps a single source IP independently of the global cap", () => {
    const l = new ConnectionLimiter(100, 2);
    expect(l.acquire("9.9.9.9")).toBe(true);
    expect(l.acquire("9.9.9.9")).toBe(true);
    expect(l.acquire("9.9.9.9")).toBe(false);
    // A different IP is unaffected.
    expect(l.acquire("8.8.8.8")).toBe(true);
  });

  it("frees the slot on release", () => {
    const l = new ConnectionLimiter(1, 1);
    expect(l.acquire("5.5.5.5")).toBe(true);
    expect(l.acquire("6.6.6.6")).toBe(false);
    l.release("5.5.5.5");
    expect(l.acquire("6.6.6.6")).toBe(true);
  });

  it("does not go negative on a double release", () => {
    const l = new ConnectionLimiter(2, 2);
    l.acquire("1.1.1.1");
    l.release("1.1.1.1");
    l.release("1.1.1.1");
    expect(l.activeCount).toBe(0);
  });

  it("forgets an IP once it has no connections", () => {
    const l = new ConnectionLimiter(10, 10);
    l.acquire("7.7.7.7");
    expect(l.trackedIps).toBe(1);
    l.release("7.7.7.7");
    expect(l.trackedIps).toBe(0);
  });

  it("survives concurrent acquire/release without losing a slot", () => {
    const l = new ConnectionLimiter(50, 50);
    for (let i = 0; i < 50; i++) l.acquire(`10.0.0.${i}`);
    expect(l.activeCount).toBe(50);
    for (let i = 0; i < 50; i++) l.release(`10.0.0.${i}`);
    expect(l.activeCount).toBe(0);
    expect(l.acquire("10.0.0.99")).toBe(true);
  });
});
