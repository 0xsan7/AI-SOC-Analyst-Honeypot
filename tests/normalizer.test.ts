import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents, tailEvents, DEFAULT_LOG } from "../src/mastra/normalizer";
import type { AttackEvent } from "../src/mastra/schemas";

const valid: AttackEvent = {
  id: "evt-1",
  timestamp: new Date().toISOString(),
  sourceIp: "203.0.113.7",
  sourcePort: 51234,
  service: "ssh",
  usernameTried: "root",
  passwordTried: "hunter2",
  commandsAttempted: ["uname -a"],
  sessionDurationMs: 1200,
  raw: {},
};

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "normalizer-"));
  log = join(dir, "events.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readEvents resilience", () => {
  it("returns an empty array when the log does not exist", async () => {
    expect(await readEvents(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("returns an empty array for an empty file", async () => {
    writeFileSync(log, "");
    expect(await readEvents(log)).toEqual([]);
  });

  it("recovers valid events around truncated, binary and junk lines", async () => {
    // A real log gets truncated by a crash, interleaved with partial writes,
    // and can contain a NUL byte from a torn write. None may take out the
    // whole batch -- losing one good event because a neighbour was corrupt
    // is the failure mode that matters.
    writeFileSync(
      log,
      [
        JSON.stringify(valid), // good
        '{"id":"evt-2","timestamp":"not-a-date"', // truncated JSON
        "not json at all", // junk
        "\0\0\0binary\0garbage", // NUL bytes
        "{", // lone brace
        JSON.stringify({ ...valid, id: "evt-3" }), // good
        "[]", // valid JSON, wrong shape
        JSON.stringify({ id: "evt-4" }), // valid JSON, missing required fields
        JSON.stringify({ ...valid, id: "evt-5" }), // good
      ].join("\n"),
    );

    const events = await readEvents(log);
    expect(events.map((e) => e.id)).toEqual(["evt-1", "evt-3", "evt-5"]);
  });

  it("does not crash on a line that is a bare primitive", async () => {
    writeFileSync(log, ["null", "123", '"a string"', "true", JSON.stringify(valid)].join("\n"));
    const events = await readEvents(log);
    expect(events.map((e) => e.id)).toEqual(["evt-1"]);
  });

  it("survives a log with no trailing newline", async () => {
    writeFileSync(log, JSON.stringify(valid)); // no \n
    expect((await readEvents(log)).map((e) => e.id)).toEqual(["evt-1"]);
  });
});

describe("tailEvents", () => {
  it("emits events as complete lines land, ignoring a partial line", async () => {
    const seen: string[] = [];
    const stop = tailEvents(log, (e) => seen.push(e.id));
    try {
      // Half a line: must not be emitted or thrown on.
      writeFileSync(log, JSON.stringify(valid).slice(0, 20));
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual([]);

      // Complete it. Now the whole event is valid and must be delivered.
      writeFileSync(log, JSON.stringify(valid) + "\n");
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual(["evt-1"]);
    } finally {
      stop();
    }
  });

  it("does not throw when the log is deleted mid-tail", async () => {
    const seen: string[] = [];
    const stop = tailEvents(log, (e) => seen.push(e.id));
    try {
      writeFileSync(log, JSON.stringify(valid) + "\n");
      // Wait past the 1s poll interval so the first event is delivered before
      // the file disappears -- otherwise this tests the tail, not the delete.
      await new Promise((r) => setTimeout(r, 1300));
      rmSync(log, { force: true });
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual(["evt-1"]);
    } finally {
      stop();
    }
  });

  it("recovers when the log is replaced by a LARGER file (rotation)", async () => {
    const seen: string[] = [];
    const stop = tailEvents(log, (e) => seen.push(e.id));
    try {
      writeFileSync(log, JSON.stringify(valid) + "\n");
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual(["evt-1"]);

      // Replace with a longer file at the same path, as logrotate does.
      // Size alone says "appended", so this only works if rotation is
      // detected by inode -- otherwise the tail resumes mid-line and the
      // new event is silently dropped.
      const bigger = { ...valid, id: "evt-rotated-with-a-longer-id", commandsAttempted: ["a", "b", "c"] };
      writeFileSync(log, JSON.stringify(bigger) + "\n");
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual(["evt-1", "evt-rotated-with-a-longer-id"]);
    } finally {
      stop();
    }
  });

  it("keeps working after the log is truncated in place", async () => {
    const seen: string[] = [];
    const stop = tailEvents(log, (e) => seen.push(e.id));
    try {
      writeFileSync(log, JSON.stringify(valid) + "\n");
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual(["evt-1"]);

      // Same inode, shorter file: caught by the length check.
      writeFileSync(log, JSON.stringify({ ...valid, id: "evt-trunc" }) + "\n");
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual(["evt-1", "evt-trunc"]);
    } finally {
      stop();
    }
  });

  it("handles non-ASCII commands without corrupting later lines", async () => {
    // offset is a string index but was previously a byte count. A captured
    // command with multi-byte characters shifts the two apart, and every
    // subsequent line was sliced mid-codepoint and lost.
    const seen: string[] = [];
    const stop = tailEvents(log, (e) => seen.push(e.id));
    try {
      writeFileSync(
        log,
        JSON.stringify({ ...valid, id: "evt-unicode", commandsAttempted: ["echo '🔴 ünïcödé 密码'"] }) + "\n",
      );
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual(["evt-unicode"]);

      // Append a second event after the multi-byte one.
      writeFileSync(
        log,
        JSON.stringify({ ...valid, id: "evt-unicode", commandsAttempted: ["echo '🔴 ünïcödé 密码'"] }) +
          "\n" +
          JSON.stringify({ ...valid, id: "evt-after-unicode" }) +
          "\n",
      );
      await new Promise((r) => setTimeout(r, 1300));
      expect(seen).toEqual(["evt-unicode", "evt-after-unicode"]);
    } finally {
      stop();
    }
  });
});

describe("default log path", () => {
  it("points at the honeypot output", () => {
    expect(DEFAULT_LOG).toBe("data/events.jsonl");
  });
});
