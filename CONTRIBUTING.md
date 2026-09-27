# Contributing

Thanks for considering a contribution. This is a solo-built defensive security
tool, so the bar is specific: **changes must be verifiable, and claims must
match what the code actually does.**

## The standard

An acceptance criterion is not satisfied until it has been executed end to end
with real inputs. A tool appearing in a list, a handler existing, or a test that
never calls the thing it names — none of these count. They assert that code
parses and registers, which is strictly weaker than "it works."

This is not theoretical here. `ask_soc_agent` was broken on every call and the
suite was green, because the MCP test listed the tool and never invoked it.

Two rules follow, and both apply to your PR:

1. **A test that does not call the thing it is named for is not a test of it.**
2. **A test that cannot fail is worse than no test**, because it gets counted.

Before trusting any new guard, break the code it guards and confirm it goes
red. Report that check in the PR description.

## Setup

```bash
git clone https://github.com/0xsan7/Honeypot.git
cd Honeypot
npm install
cp .env.example .env      # placeholders are fine for everything except live triage
npm run setup             # host keys, frontend build, demo data
```

Node 22.13 or newer. No API key is needed to run the tests.

## Before you open a pull request

```bash
npm run test:all
```

That runs the typecheck, 56 unit tests, and five process-boundary suites. It
must exit `0`. If you touched `web/`, also run `npm run build` in `web/`.

CI runs the same commands, plus a secret scan. All of it must pass with no
credentials present.

## Conventions

- TypeScript, no `any` in new code unless a comment says why.
- Comments explain **why**, not what. If a line is surprising, the surprise is
  the reason it needs a comment.
- No `child_process`, `spawn`, `exec`, or `eval` anywhere under `src/honeypot/`.
  The honeypot must never execute an attacker's input. `RegExp.exec()` is fine;
  process execution is not. CI does not check this yet, so be careful by hand.
- Secrets never go in the repository. `.env` is ignored; `.env.example` holds
  placeholders only. If you add a credential to a commit by accident, say so
  immediately — a rotated key is cheap, a leaked one is not.

## What would be genuinely useful

- Port or Wireshark parsing for the SSH and HTTP decoys.
- Additional enrichment sources beyond geo/ASN and AbuseIPDB.
- Frontend work on the SOC console or landing page.
- Bugs in the correlation or reporting logic, with a failing test attached.

Attack tooling, scanning, blocking, or anything targeting a third party is out
of scope. This is a single-operator defensive tool.

## Reporting a bug

Open an issue with what you expected, what happened, and how to reproduce it.
If it involves a live key or a real attacker IP, say so and redact the details.

Security issues: see [SECURITY.md](SECURITY.md), not a public issue.
