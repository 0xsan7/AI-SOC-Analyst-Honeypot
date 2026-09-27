# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | yes |

## Reporting a vulnerability

Email the maintainer directly rather than opening a public issue. Include the
component, reproduction steps, and impact. You should get an acknowledgement
within a few days.

If you have already reported something publicly, that is fine — just say so in
the report so it can be triaged with context.

## Scope

This project is a **honeypot**: it is meant to be attacked, and it records real
attacker credentials and commands in plaintext. Finding that working is a sign
it is functioning, not a vulnerability. The following are in scope:

- A way to make the honeypot execute an attacker's command or payload. The
  no-execution guarantee is the central security property; anything that breaks
  it is critical.
- A way to read or write the database, event log, or reports without going
  through the intended path.
- A way to make agent memory or the MCP tools return data from one source than
  the one asked for — for example answering about a different store, or
  crossing a query boundary in the campaign tools.
- Credentials or secrets committed to the repository.
- Path traversal, or the dashboard serving files outside its intended roots.
- Unbounded resource growth in the event log or connection count.

Out of scope:

- The absence of authentication on the dashboard or the MCP server. Both are
  documented as local-only and are meant to be reached over an SSH tunnel. A
  report saying "the dashboard has no login" is a restatement of the design,
  not a finding.
- Traffic reaching the honeypot, or the content of attacker commands.
- Denial of service by flooding the honeypot. There are connection caps and log
  rotation precisely because this is expected.

## Deployment assumptions

Documented in [DEPLOY.md](DEPLOY.md), and load-bearing:

- The honeypot binds `0.0.0.0`; the dashboard stays on `127.0.0.1`.
- MCP is stdio-only and must not be exposed over a network. It has no
  authentication.
- The dashboard has no authentication. It is not meant to be public.

If you deploy it differently and something breaks, that is a misconfiguration
against these assumptions rather than a bug — though a better failure mode
would be welcome as feedback.
