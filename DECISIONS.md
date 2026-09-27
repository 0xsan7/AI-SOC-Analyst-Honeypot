# DECISIONS

Autonomous work log. One line per decision with the reason, written as it was
made. Not a summary — read `git log` for what changed.

---

## D1 — Campaign auto-close threshold: 24 hours

`closeIdleCampaigns()` closes any `open` campaign whose `lastSeen` is older than
`CAMPAIGN_IDLE_CLOSE_MS` (default 24h, env-overridable). Called at the top of
`scripts/correlate.ts`, before correlation.

Why 24h: long enough that a periodic scanner hitting once a day keeps one
campaign open instead of opening a new one daily, and short enough that a
resolved incident stops counting as active the next day. Below ~6h a slow
scanner's own cadence would fragment it; above ~48h a dead incident looks live
for two days, which is the exact problem auto-closing exists to solve.

**Consequence worth knowing:** a closed campaign can never be rejoined —
`findMatchingCampaign` matches `status = 'open'` only. A source that returns
after the window gets a *new* campaign rather than reviving the old one. Chose
immutable history over silent revival: an incident report that changes its
event list after the fact is harder to trust than two sequential reports.

## D2 — Auto-close test asserts an exact end state, not "everything closed"

`scripts/test-auto-close.ts` runs three separate processes: correlate with the
default threshold, correlate again with the threshold collapsed to 1ms, then a
fresh process reads the store back. End state is **1 closed + 1 open**.

Worth recording because the first version asserted *every* campaign was closed
and failed. The implementation was right and the test was wrong: pass 2
reprocesses the same event, the original campaign is closed, so correlation
cannot match it and correctly opens a fresh one. See D1.

The read-back probe must live inside the repo — `tsx` picks module type from
the nearest `package.json`, so a probe in a temp dir is treated as CJS and
top-level await is a syntax error. That failure was silent (stderr swallowed by
a `?? "[]"` fallback, surfacing as an empty store), so the test now asserts the
probe actually printed before parsing it.

## D3 — Ponytail is unavailable in this environment

`/ponytail-review` is an OpenCode slash command. OpenCode is not installed on
this machine (no binary, no global npm package), and the plugin declared in
`opencode.json` (`@dietrichgebert/ponytail`, published as 4.10.0) is not
installed locally. The command cannot be invoked from this session.

Did the cleanup that the manual pass would have done — removed three
debug-only files (`probe.mjs`, `echo.mjs`, `scripts/probe-mcp-raw.ts`) that
were diagnostics for the MCP protocol bug and referenced nowhere.

**This is not equivalent to running the real review.** A manual read is my own
judgement, not the plugin's guarantee. Recorded here so the absence of a
ponytail pass is not mistaken for a pass.
