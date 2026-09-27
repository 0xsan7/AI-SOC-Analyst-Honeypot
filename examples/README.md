# Example output

Committed samples so you can see what the system produces before running it.
All data here is **synthetic** — the IPs are from `198.51.100.0/24` and
`203.0.113.0/24` (RFC 5737 documentation ranges), and the credentials are the
obvious ones an automated scanner tries first. Nothing here came from a real
attacker or a real host.

| File | What it shows |
| --- | --- |
| [`example-report.md`](example-report.md) | Severity 5 campaign, 6 events — the escalation path. Exactly what `npm run seed && npm run correlate` produces. |
| [`example-closed-campaign.md`](example-closed-campaign.md) | A campaign after auto-close: `Status: closed`, showing how a resolved incident reads once it goes quiet. |

Regenerate your own:

```bash
npm run seed        # 20 synthetic events, no API key needed
npm run correlate   # -> reports/*.md and the campaign list
```

## Reading a report

- **Severity** — LLM-graded 1–5. 5 is active exploitation.
- **Status** — `open` while events keep arriving; `closed` after 24h idle
  (tune with `CAMPAIGN_IDLE_CLOSE_MS`).
- **In plain language** — the same facts for someone who does not read triage
  output. Written by the same deterministic template, so it never invents a
  detail that is not in the events.

The report generator is deterministic and makes no LLM calls: same input file,
byte-identical output. Gemini quota cannot change what a report says.
