/**
 * Observability, with the model mocked.
 *
 * Free, permanent counterpart to `npm run test:studio`, which needs a live
 * Gemini key and a running Studio process. This proves the same invariant --
 * a workflow run produces spans that can be read back -- without either.
 *
 * Spans are written to an in-process observability store, so this builds its
 * own Mastra with its own store rather than reading a developer's Studio.
 * The read path is `store.getStore("observability")`, the same call
 * `src/mastra/index.ts` uses to register the DuckDB domain.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { MastraCompositeStore } from "@mastra/core/storage";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "obs-mock-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A workflow standing in for triage: a real step, no LLM behind it. */
function buildWorkflow(id: string, shouldThrow = false) {
  const step = createStep({
    id: `${id}-step`,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    execute: async ({ inputData }: { inputData: { value: string } }) => {
      if (shouldThrow) throw new Error("classifier exploded");
      return { value: inputData.value };
    },
  });
  return createWorkflow({
    id,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
  })
    .then(step)
    .commit();
}

async function buildMastra(workflowId: string, shouldThrow = false) {
  const workflow = buildWorkflow(workflowId, shouldThrow);
  // DuckDB, matching src/mastra/index.ts, so this exercises the same storage
  // adapter production uses.
  //
  // A bare LibSQLStore is NOT sufficient: MastraStorageExporter reads
  // `observabilityStrategy` off the store and throws "Cannot read properties
  // of undefined (reading 'preferred')" when it is absent, and spans then go
  // nowhere. getStore("observability") wraps the default store in an
  // ObservabilityLibSQL adapter that does have the strategy, so either form
  // works -- this mirrors production rather than depending on that fallback.
  const { DuckDBStore } = await import("@mastra/duckdb");
  const observability = await new DuckDBStore().getStore("observability");
  const mastra = new Mastra({
    workflows: { [workflowId]: workflow },
    storage: new MastraCompositeStore({
      id: "obs-composite",
      default: new LibSQLStore({ id: "obs-storage", url: "file::memory:" }),
      domains: { observability },
    }),
    observability: new Observability({
      configs: {
        default: {
          serviceName: "obs-test",
          exporters: [new MastraStorageExporter()],
        },
      },
    }),
  });
  return { mastra, workflow };
}

describe("workflow observability (mocked)", () => {
  it("records a span for a workflow run that can be read back", async () => {
    const { mastra } = await buildMastra("triage-mock");

    // Run it through the Mastra instance, not the raw workflow object. Only
    // the instance-resolved workflow carries the observability context, so
    // running the bare object succeeds but records nothing -- which is exactly
    // the shape of "looks configured, silently records nothing".
    const workflow = mastra.getWorkflow("triage-mock");
    const run = await workflow.createRun();
    const result = await run.start({ inputData: { value: "attack" } });
    expect(result.status).toBe("success");

    const obsStore = (await mastra.getStorage().getStore("observability")) as unknown as {
      listTraces: (a: unknown) => Promise<{ spans: Array<{ name?: string }> }>;
    };

    // Spans flush asynchronously, and it is not fast: the run finishes in
    // milliseconds but the first span landed around 4s in a standalone probe.
    // A fixed short sleep therefore reads as "observability is broken" when it
    // is only late. Poll for a bounded window instead.
    let traces: Array<{ name?: string }> = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      traces = (await obsStore.listTraces({})).spans;
      if (traces.length > 0) break;
    }

    expect(traces.length).toBeGreaterThan(0);
    expect(traces.some((t) => /triage-mock/.test(t.name ?? ""))).toBe(true);
  }, 40000);

  it("the storage adapter can actually record spans", async () => {
    // Guards the premise of the test above. A store without an
    // observabilityStrategy makes MastraStorageExporter throw during init,
    // after which every run "succeeds" and every listTraces() is empty --
    // indistinguishable from working setup unless something asserts the
    // adapter itself.
    const { DuckDBStore } = await import("@mastra/duckdb");
    const store = await new DuckDBStore().getStore("observability");
    expect(store.observabilityStrategy).toBeDefined();
    expect(store.observabilityStrategy.preferred).toBe("event-sourced");
  }, 30000);

  it("a failing step is reported as a failed run, not a silent success", async () => {
    const { workflow } = await buildMastra("triage-fail", true);

    const run = await workflow.createRun();
    const result = await run.start({ inputData: { value: "x" } });

    expect(result.status).not.toBe("success");
  }, 30000);

  it("an unrun workflow records no spans", async () => {
    const { mastra } = await buildMastra("triage-unused");

    const obsStore = await mastra.getStorage().getStore("observability");
    const { spans: traces } = await (obsStore as unknown as {
      listTraces: (a: unknown) => Promise<{ spans: unknown[] }>;
    }).listTraces({});

    // Guards against the read path returning everything regardless of whether
    // a run happened -- the failure mode that would make the test above pass
    // for the wrong reason.
    expect(traces.filter((t) => /triage-unused/.test(JSON.stringify(t)))).toHaveLength(0);
  }, 30000);
});
