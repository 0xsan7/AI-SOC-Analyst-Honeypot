# DEPLOY.md

Running this on a public VPS. Read the security section first.

**You are putting an open, unauthenticated service on the internet that invites
attacks and records the credentials people try against it.** That is the point
of a honeypot, and it is a deliberate choice — just make it knowingly.

---

## Before you start

You need:

- A VPS with a **public IPv4 address** (required — a honeypot behind NAT or CGNAT
  is unreachable and collects nothing)
- Node 22.13+ on it
- A Gemini API key in `.env` (only for live triage; the honeypot itself needs none)

**Pick your provider.** For this workload — low CPU, lots of inbound connections,
tiny log volume — the cheapest viable tier is fine:

| Provider | Cheapest | Notes |
| --- | --- | --- |
| **Oracle Cloud Always Free** | $0 | 2× AMD micro VM + public IPv4, does not expire. Best option if you can get a shape — ARM A1 capacity is a lottery, AMD E2.1.Micro is reliable. |
| **Hetzner CX23** | ~€5.49/mo | Cheapest reliable paid VPS, 2 vCPU / 4 GB. |
| **DigitalOcean / Linode** | ~$6/mo | Straightforward, pricier. |

Free tiers (Oracle, Fly.io, Render) are poor fits beyond the page: many have no
public IP by default, and PaaS platforms that suspend idle free apps will take
your honeypot offline exactly when you want it up.

---

## Deploy

### 1. Provision the box and lock it down

```bash
ssh root@YOUR_IP          # or the provider's default user (opc / ubuntu / debian)
```

Before anything else:

```bash
adduser soc && usermod -aG sudo soc
# copy your SSH key, then verify you can log in as soc — BEFORE disabling root
```

Set up the firewall. **Only the honeypot ports should be open to the world:**

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # your SSH — from YOUR ip if you can
ufw allow 2222/tcp    # the SSH honeypot
ufw allow 8080/tcp    # the HTTP honeypot
ufw enable
```

Unattended security updates:

```bash
apt update && apt install -y unattended-upgrades
dpkg-reconfigure --priority=low unattended-upgrades
```

### 2. Install Node and the project

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
git clone https://github.com/0xsan7/Honeypot.git
cd Honeypot
npm install
npm run setup          # host keys + frontend build + demo data
```

Put your Gemini key in `.env` if you want live triage. Then check the file
permissions — it holds a credential:

```bash
chmod 600 .env
```

### 3. Run it

The honeypots bind to `0.0.0.0` deliberately. **The dashboard does not** — keep
it on loopback and reach it through an SSH tunnel:

```bash
HONEYPOT_BIND=0.0.0.0 npm run honeypot
HONEYPOT_BIND=0.0.0.0 HTTP_HONEYPOT_BIND=0.0.0.0 npm run honeypot:http
npm run dashboard       # stays on 127.0.0.1:4173
```

Tunnel from your laptop:

```bash
ssh -N -L 4173:127.0.0.1:4173 soc@YOUR_IP
```

Then browse `http://127.0.0.1:4173`. The console and MCP server are never
exposed to the internet this way.

### 4. Survive reboots (systemd)

`/etc/systemd/system/soc-honeypot@.service`:

```ini
[Unit]
Description=AI SOC Analyst honeypot (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=soc
WorkingDirectory=/home/soc/Honeypot
Environment=HONEYPOT_BIND=0.0.0.0
Environment=HTTP_HONEYPOT_BIND=0.0.0.0
EnvironmentFile=/home/soc/Honeypot/.env
ExecStart=/usr/bin/npx tsx src/honeypot/%i-server.ts
Restart=always
RestartSec=5

# The process needs nothing else. Deny it everything.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/soc/Honeypot/data /home/soc/Honeypot/reports

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now soc-honeypot@ssh soc-honeypot@http
sudo systemctl status soc-honeypot@ssh
```

The `ProtectSystem=strict` / `ProtectHome=read-only` lines are the point: if the
honeypot process is ever exploited, it still cannot write outside `data/`.

### 5. Keep it fed

The pipeline costs Gemini quota, and the free tier is ~20 classifications/day.
A cron that runs hourly will start failing once traffic exceeds that — which is
fine, it degrades gracefully, but you will want to know:

```bash
crontab -e
```

```cron
17 * * * * cd /home/soc/Honeypot && /usr/bin/npx tsx scripts/run-pipeline.ts >> /home/soc/Honeypot/data/pipeline.log 2>&1
```

Check `data/pipeline.log` for `PIPELINE FAILED` — the command exits non-zero
when nothing was enriched, so cron will not silently mask it.

Correlation and reporting are deterministic and free — run those as often as
you like.

---

## Verify it works

From your own machine:

```bash
ssh -p 2222 root@YOUR_IP          # any password
curl -s -o /dev/null -w '%{http_code}\n' http://YOUR_IP:8080/admin   # want 401
```

On the box:

```bash
wc -l data/events.jsonl                       # should be growing
sudo journalctl -u soc-honeypot@ssh -n 50
```

**First contact takes minutes, not hours.** An exposed port is found by scanners
quickly; if the log is empty after an hour, check the firewall and that the
service is actually bound to `0.0.0.0`.

---

## Operations

**Disk is bounded.** The event log rotates at 50 MB keeping 5 generations
(~250 MB ceiling). Tune with `LOG_MAX_BYTES` / `LOG_MAX_FILES`.

**Connections are capped.** 64 concurrent, 8 per source IP
(`MAX_CONNECTIONS` / `MAX_PER_IP`). At capacity the *new* connection is refused
rather than dropping a live session — a scanner retries, and you keep the
capture.

**Back up what matters.** `soc-analyst.db` (campaigns) and `reports/` are the
only irreplaceable data. `data/events.jsonl` is raw traffic you can re-ingest.

The store is LibSQL, so the `sqlite3` CLI is the wrong tool. Use the script —
it does a consistent online copy via `VACUUM INTO`, so the honeypot can keep
writing while the backup runs:

```bash
npm run backup        # -> backup/soc-<timestamp>.db
```

Set `BACKUP_DIR` to put backups elsewhere. Do not `cp` a live store: it is WAL
mode, and a copy taken mid-write can be inconsistent. If you point
`TURSO_DATABASE_URL` at a remote LibSQL, this script will tell you — Turso has
its own replication and point-in-time recovery.

**Watch the disk**, since it is the thing that will kill a small box:

```bash
df -h / && du -sh data/ reports/
```

---

## What not to do

- **Do not expose the dashboard or MCP server.** Neither has authentication.
  Keep both on loopback behind an SSH tunnel. If you need remote MCP, put it
  behind a reverse proxy with real auth.
- **Do not run the honeypot on a machine holding anything you care about.**
  Use a dedicated box. A honeypot is a target by definition.
- **Do not put a real credential in `.env` on a public box** beyond the Gemini
  key, and keep it `chmod 600`.
- **Do not bind to `0.0.0.0` on your laptop or a shared host.** A honeypot on a
  network you do not own is not your call to make.
- **Do not expect the free tier to stay free** without checking. Set a billing
  budget alarm in the provider console.

---

## Legal, briefly

Running a honeypot on infrastructure you own is legitimate and widely done. Two
things worth knowing: some providers require you to declare it in their AUP
(Oracle and Hetzner both tolerate it; check before you leave it running), and
captured attacker IPs are personal data under GDPR — you are processing IP
addresses and attempted credentials belonging to people who did not consent.
Publishing campaign reports with live IPs is where this gets interesting. The
synthetic examples in `examples/` avoid it deliberately.
