/**
 * One-command first run: host keys, frontend build, demo data.
 *
 * The frontend lives in web/ with its own dependencies, so a bare `npm install`
 * at the root does not build it -- which is what made a fresh clone serve a
 * 404 at / . Rather than hide that behind a postinstall (which would make every
 * install slow and break offline use), it is one explicit command.
 *
 * Usage: npm run setup
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function step(name: string, fn: () => boolean) {
  process.stdout.write(`\n[setup] ${name}\n`);
  if (!fn()) {
    console.error(`\n[setup] FAILED at: ${name}`);
    process.exit(1);
  }
}

step("generating honeypot host keys", () => {
  if (existsSync(join(ROOT, "honeypot/keys/host_ed25519"))) {
    console.log("          already present, skipping");
    return true;
  }
  return spawnSync("npm", ["run", "keys"], { cwd: ROOT, stdio: "inherit" }).status === 0;
});

step("building the landing page (web/)", () => {
  const web = join(ROOT, "web");
  if (!existsSync(join(web, "node_modules"))) {
    const install = spawnSync("npm", ["install"], { cwd: web, stdio: "inherit" });
    if (install.status !== 0) return false;
  }
  return spawnSync("npm", ["run", "build"], { cwd: web, stdio: "inherit" }).status === 0;
});

step("seeding demo data (no API key needed)", () => {
  if (!existsSync(join(ROOT, ".env"))) {
    console.log("          no .env — copy .env.example and add your Gemini key for live triage");
    return true;
  }
  const seed = spawnSync("npm", ["run", "seed"], { cwd: ROOT, stdio: "inherit" });
  if (seed.status !== 0) return false;
  return spawnSync("npm", ["run", "correlate"], { cwd: ROOT, stdio: "inherit" }).status === 0;
});

console.log(`
[setup] done.

  npm run dashboard   then open http://127.0.0.1:4173
  npm run honeypot    to start capturing real SSH sessions
  npm run pipeline    to triage captured events (needs a Gemini key)
`);
