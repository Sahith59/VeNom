// End-to-end test of the built CLI: spawns `node dist/cli.js` like a real user would.
// Requires a prior build (the `test` script runs `npm run build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

function run(args, opts = {}) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, ...opts });
}

test("cli --version prints the package version", () => {
  const v = run(["--version"]).trim();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(v, pkg.version);
});

test("cli --help documents the commands", () => {
  const out = run(["--help"]);
  assert.match(out, /venom init/);
  assert.match(out, /venom list/);
  assert.match(out, /venom add/);
});

test("cli list shows all 6 packs", () => {
  const out = run(["list"]);
  for (const id of ["web-app", "data-ml", "research-academic", "writing-content", "security-audit", "solo-minimal"]) {
    assert.match(out, new RegExp(id), `list mentions ${id}`);
  }
});

test("cli with no subcommand in a non-TTY prints help and does NOT silently scaffold", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-cli-"));
  try {
    const out = run([], { cwd: t }); // execFileSync pipes stdio, so stdin is not a TTY
    assert.match(out, /list/, "shows help (lists commands)");
    assert.match(out, /memory/, "shows help (lists commands)");
    assert.equal(existsSync(join(t, "CHARTER.md")), false, "did NOT scaffold a team unprompted");
    assert.equal(existsSync(join(t, "agent-memory")), false, "no agent-memory written unprompted");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("cli init (non-interactive) installs a working team and fills the charter", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-cli-"));
  try {
    const out = run([
      "init", "--dir", t, "--pack", "solo-minimal", "--name", "My CLI Test",
      "--one-liner", "A payments API", "--non-negotiables", "never log card numbers; fail closed", "--yes",
    ]);
    assert.match(out, /Installed the Solo Minimal team — 8 agents for Claude Code/, "reports the solo-minimal count");
    assert.match(out, /auto-selected/, "notes the tool was defaulted when --tool is omitted");

    assert.ok(existsSync(join(t, ".claude", "agents", "boss-1.md")), "boss-1 installed");
    assert.ok(existsSync(join(t, ".claude", "agents", "developer-1.md")), "developer-1 installed");
    assert.ok(!existsSync(join(t, ".claude", "agents", "design.md")), "solo-minimal excludes design");
    assert.ok(existsSync(join(t, ".claude", "settings.json")), "settings written");

    const charter = readFileSync(join(t, "CHARTER.md"), "utf8");
    assert.match(charter, /My CLI Test/, "project name filled");
    assert.match(charter, /A payments API/, "one-liner filled");
    assert.match(charter, /never log card numbers/, "non-negotiables filled");
    assert.ok(!/\{\{/.test(charter), "NO unfilled {{placeholders}} remain");
    assert.ok(!/delete once yours are filled in/.test(charter), "template example comment stripped");

    assert.ok(existsSync(join(t, "CLAUDE.md")), "lead-session brief written");
    assert.ok(existsSync(join(t, "agent-memory", "SNAPSHOT.md")), "memory tier placed");
    const rec = JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8"));
    assert.equal(rec.pack, "solo-minimal");
    assert.equal(rec.roles.length, 8);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("cli add appends an optional role to an existing install", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-cli-"));
  try {
    run(["init", "--dir", t, "--pack", "solo-minimal", "--name", "X", "--yes"]);
    const out = run(["add", "marketing", "--dir", t]);
    assert.match(out, /Added marketing/);
    assert.ok(existsSync(join(t, ".claude", "agents", "marketing.md")), "marketing rendered");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("re-init preserves roles added via `venom add`", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-cli-"));
  try {
    run(["init", "--dir", t, "--pack", "solo-minimal", "--name", "X", "--yes"]);
    run(["add", "marketing", "--dir", t]);
    assert.ok(existsSync(join(t, ".claude", "agents", "marketing.md")), "marketing present after add");
    run(["init", "--dir", t, "--pack", "solo-minimal", "--yes"]); // a plain re-init must NOT drop it
    assert.ok(existsSync(join(t, ".claude", "agents", "marketing.md")), "marketing survives re-init");
    const rec = JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8"));
    assert.ok(rec.extraRoles.includes("marketing"), "extraRoles persisted in the record");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("cli add routes through the installed tool's adapter (gemini)", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-cli-"));
  try {
    run(["init", "--dir", t, "--tool", "gemini", "--pack", "solo-minimal", "--name", "X", "--yes"]);
    const out = run(["add", "marketing", "--dir", t]);
    assert.match(out, /Added marketing/);
    assert.ok(existsSync(join(t, ".gemini", "commands", "venom", "marketing.toml")), "marketing command rendered");
    assert.ok(!existsSync(join(t, ".claude")), "add used the recorded gemini tool, not the default");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("cli init --tool codex installs an AGENTS.md team", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-cli-"));
  try {
    const out = run(["init", "--dir", t, "--tool", "codex", "--pack", "solo-minimal", "--name", "X", "--yes"]);
    assert.match(out, /Installed the .* team .* for Codex/, "reports a Codex install");
    assert.ok(!/auto-selected/.test(out), "an explicit --tool shows no auto-select note");
    assert.ok(existsSync(join(t, "AGENTS.md")), "AGENTS.md written");
    assert.ok(existsSync(join(t, ".venom", "agents", "boss-1.md")), "role specs written");
    assert.ok(!existsSync(join(t, ".claude")), "no Claude Code artifacts");
    const rec = JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8"));
    assert.equal(rec.tool, "codex");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("cli init --tool gemini installs slash-command roles", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-cli-"));
  try {
    const out = run(["init", "--dir", t, "--tool", "gemini", "--pack", "solo-minimal", "--name", "X", "--yes"]);
    assert.match(out, /for Gemini CLI/, "reports a Gemini install");
    assert.ok(existsSync(join(t, "GEMINI.md")), "GEMINI.md written");
    assert.ok(existsSync(join(t, ".gemini", "commands", "venom", "boss-1.toml")), "/venom:boss-1 command written");
    const rec = JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8"));
    assert.equal(rec.tool, "gemini");
  } finally { rmSync(t, { recursive: true, force: true }); }
});
