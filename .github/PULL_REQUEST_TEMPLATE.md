## What this changes

One or two sentences. Link the issue it closes if there is one.

Closes #

## How it was verified

Do not just say "tests pass". Say what you ran and what you saw.

- [ ] `npm run test:all` exits 0
- [ ] `npm run build` in `web/` succeeds (if you touched `web/`)
- [ ] For a new test: I broke the code it guards and confirmed it went red

If this fixes a bug, include the failing test and the output that showed the
failure before the fix. A test added alongside a fix should be shown failing
against the unfixed code — otherwise there is no evidence it guards anything.

Paste the relevant output:

```
```

## Notes for the reviewer

Anything surprising, a decision you reversed, or a part you are unsure about.
Links to `DECISIONS.md` or `TESTING.md` are welcome.

- [ ] No secrets, real attacker IPs, or credentials in the diff
- [ ] No command-execution path introduced under `src/honeypot/`
