/**
 * Triage workflow: classify (LLM) -> enrich (threat intel).
 * Per PRD FR3 every AttackEvent is classified before it is persisted as an
 * EnrichedEvent. Per FR4 enrichment failures are warnings, never fatal.
 */
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { enrich } from "./enrich";
import {
  AttackEventSchema,
  CLASSIFICATIONS,
  EnrichedEventSchema,
  type AttackEvent,
} from "./schemas";

export const CLASSIFIER_MODEL = "google/gemini-3.5-flash";

const VerdictSchema = z.object({
  classification: z.enum(CLASSIFICATIONS),
  severity: z.number().int().min(1).max(5),
  reasoning: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * Injected so tests can classify with a fake, never a live LLM call
 * (PRD section 12).
 */
export type Classifier = (event: AttackEvent) => Promise<Verdict>;

const DEFAULT_SYSTEM_PROMPT = `You are a SOC triage classifier for a defensive honeypot.
Classify the SSH session into exactly one of: noise, recon, credential_stuffing, active_exploit_attempt.
- noise: port scan or a bare connection with no meaningful payload.
- recon: enumeration (ls, uname, whoami, cat /etc/passwd).
- credential_stuffing: brute-forced or default/common credential attempts.
- active_exploit_attempt: privilege escalation, payload download, or exploitation.

Severity is 1-5: 1-2 benign, 3 probing, 4 serious intent, 5 active exploitation.
Reply with JSON only: {"classification":"...","severity":N,"reasoning":"one short sentence"}`;

/** LLM-backed classifier, with backoff on 429/5xx (free-tier friendly, Step 5). */
export const llmClassifier: Classifier = async (event) => {
  const agent = new Agent({
    id: "triage-classifier",
    name: "Triage Classifier",
    instructions: DEFAULT_SYSTEM_PROMPT,
    model: CLASSIFIER_MODEL,
  });
  const prompt = `Classify this honeypot session:\n${JSON.stringify({
    usernameTried: event.usernameTried,
    passwordTried: event.passwordTried,
    commandsAttempted: event.commandsAttempted,
  })}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await agent.generate(prompt);
      const match = res.text.match(/\{[\s\S]*\}/);
      if (!match)
        throw new Error(
          `classifier returned no JSON: ${res.text.slice(0, 200)}`,
        );
      return VerdictSchema.parse(JSON.parse(match[0]));
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? "";
      // Gemini's free tier has a hard per-day cap (20 req/day on 3.5-flash)
      // alongside per-minute limits. Only the transient kind is worth retrying —
      // retrying a daily-cap error just burns time.
      const hardQuota =
        /exceeded your current quota/i.test(msg) ||
        /quota exceeded.*limit: \d+/i.test(msg);
      const retryable =
        !hardQuota && /429|rate|quota|resource|overloaded|503|500/i.test(msg);
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};

/** Verdict carried alongside the original event, so the next step has the IP. */
const ClassifiedSchema = AttackEventSchema.extend(VerdictSchema.shape);

const classifyStep = createStep({
  id: "classify-event",
  description:
    "LLM-grades the event as noise/recon/credential_stuffing/active_exploit_attempt, severity 1-5",
  inputSchema: AttackEventSchema,
  outputSchema: ClassifiedSchema,
  execute: async ({ inputData, requestContext }) => {
    const classifier =
      (requestContext.get("classifier") as Classifier | undefined) ??
      llmClassifier;
    return { ...inputData, ...(await classifier(inputData)) };
  },
});

const enrichStep = createStep({
  id: "enrich-event",
  description:
    "Adds geo/ASN/reputation context; degrades gracefully when lookups fail",
  inputSchema: ClassifiedSchema,
  outputSchema: EnrichedEventSchema,
  execute: async ({ inputData }) => {
    const { geo, reputationScore, warnings } = await enrich(inputData.sourceIp);
    return { ...inputData, geo, reputationScore, enrichmentWarnings: warnings };
  },
});

export function buildTriageWorkflow() {
  return createWorkflow({
    id: "triage",
    inputSchema: AttackEventSchema,
    outputSchema: EnrichedEventSchema,
  })
    .then(classifyStep)
    .then(enrichStep)
    .commit();
}

export const triageWorkflow = buildTriageWorkflow();

/**
 * Run one event through triage and return a validated EnrichedEvent.
 * Pass a `classifier` to test without a live LLM call.
 */
export async function triageEvent(
  event: AttackEvent,
  classifier: Classifier = llmClassifier,
): Promise<ReturnType<typeof EnrichedEventSchema.parse>> {
  const requestContext = new RequestContext();
  requestContext.set("classifier", classifier);
  const run = await buildTriageWorkflow().createRun();
  const result = await run.start({ inputData: event, requestContext });
  if (result.status !== "success") {
    // Surface the underlying step error. Reporting only "triage workflow failed"
    // hides the cause (e.g. a 429) and makes retry/backoff impossible to reason
    // about.
    const stepErrs = Object.values(result.steps ?? {})
      .map((s) => (s as { error?: unknown }).error)
      .filter(Boolean)
      .map((e) => (e instanceof Error ? e.message : String(e)));
    throw new Error(
      `triage workflow ${result.status}${stepErrs.length ? `: ${stepErrs.join("; ")}` : ""}`,
    );
  }
  return EnrichedEventSchema.parse(result.result);
}
