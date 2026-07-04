// End-to-end test of the built CLI: spawns `node dist/cli.js` like a real user would.
// Requires a prior build (the `test` script runs `npm run build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
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

test("cli init --roles installs a custom roster (core gates + your picks), rejecting bad input", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-roster-"));
  try {
    run(["init", "--dir", t, "--tool", "claude-code", "--roles", "developer-1,testing", "--name", "R", "--yes"]);
    const agents = readdirSync(join(t, ".claude", "agents")).map((f) => f.replace(/\.md$/, "")).sort();
    assert.deepEqual(agents, ["boss-1", "boss-2", "critics", "developer-1", "security", "testing"], "core gates + exactly the two picks");

    // an unknown role is rejected with no partial scaffold
    const bad = mkdtempSync(join(tmpdir(), "venom-roster2-"));
    let threw = false, stderr = "";
    try {
      run(["init", "--dir", bad, "--tool", "claude-code", "--roles", "developer-1,bogusrole", "--name", "R", "--yes"]);
    } catch (e) {
      threw = true;
      stderr = String(e.stderr || e.message);
    }
    assert.ok(threw, "unknown role exits non-zero");
    assert.match(stderr, /Unknown role/, "and names the bad role");
    assert.equal(existsSync(join(bad, "CHARTER.md")), false, "no partial scaffold on a bad roster");
    rmSync(bad, { recursive: true, force: true });

    // a bare/empty --roles is a mistake, not "install nothing"
    assert.throws(() => run(["init", "--dir", mkdtempSync(join(tmpdir(), "venom-r3-")), "--roles=", "--tool", "claude-code", "--yes"]), /needs a comma|Command failed/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("cli add on a custom --roles install preserves the roster AND the model preset (no pack re-inflation)", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-addroster-"));
  try {
    // default pack (web-app) so removeRoles is non-empty — the exact condition that exposed the bug
    run(["init", "--dir", t, "--tool", "claude-code", "--roles", "developer-1", "--models", "budget", "--name", "R", "--yes"]);
    run(["add", "design", "--dir", t]);

    const agents = readdirSync(join(t, ".claude", "agents")).map((f) => f.replace(/\.md$/, "")).sort();
    assert.deepEqual(agents, ["boss-1", "boss-2", "critics", "design", "developer-1", "security"], "add keeps the custom roster; the pack did NOT re-inflate");

    const rec = JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8"));
    assert.ok(Array.isArray(rec.removeRoles) && rec.removeRoles.length > 0, "removeRoles is preserved, not blanked");
    assert.ok(!rec.removeRoles.includes("design"), "the just-added role is un-removed");
    assert.equal(rec.preset, "budget", "the chosen model preset survives an add");
    assert.match(readFileSync(join(t, ".claude", "agents", "developer-1.md"), "utf8"), /^model:\s*haiku/m, "developer-1 stays on the budget-tier model");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("cli guide walks a new user through everything; a topic narrows it; a bad topic errors", () => {
  const full = run(["guide"]);
  assert.match(full, /BOSS-1/, "overview explains the orchestrator");
  for (const t of ["start", "memory", "mcp", "cli", "cost"]) assert.match(full, new RegExp(t), `full guide covers ${t}`);
  assert.match(full, /agent-memory\//, "guide shows the memory location");

  const mem = run(["guide", "memory"]);
  assert.match(mem, /SNAPSHOT\.md/, "the memory topic describes the layout");
  assert.match(mem, /log\.archive\.md/, "layout names the archive");
  assert.match(mem, /venom memory search/, "points to the CLI viewer");
  assert.ok(!/from zero to your first goal/.test(mem), "a topic prints only its own section");

  // Honesty guard: the budget cost claim must never regress to "gates stay on the strong model"
  // (the exact defect a prior audit caught). budget downshifts the gates Opus->Sonnet.
  const cost = run(["guide", "cost"]);
  assert.match(cost, /Opus to Sonnet/, "guide states budget drops the gates Opus->Sonnet");
  assert.ok(!/gates? (stay|remain|kept?) on the (strong|top)|gates untouched/i.test(cost), "no false 'gates stay strong' claim");

  assert.throws(() => run(["guide", "bogustopic"]), /Unknown guide topic|exited/, "a bad topic is rejected");
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
