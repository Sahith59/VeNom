// Tests for M1 — model presets. Requires a prior build (for dist/models.js + dist/cli.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePreset } from "../dist/models.js";
import { install } from "../adapters/claude-code/adapter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const CORE = join(ROOT, "core");
const packs = JSON.parse(readFileSync(join(CORE, "packs.json"), "utf8"));
const roles = Object.keys(packs.roles);
const NOW = "2026-07-03T00:00:00.000Z";

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

test("resolvePreset maps group→tier→model and throws on unknown", () => {
  const budget = resolvePreset(CORE, roles, "claude-code", "budget");
  assert.equal(budget.perRole, true);
  assert.equal(budget.modelByRole["boss-1"], "sonnet", "budget bosses = mid = sonnet");
  assert.equal(budget.modelByRole["critics"], "sonnet", "budget gates = mid = sonnet");
  assert.equal(budget.modelByRole["developer-1"], "haiku", "budget workers = cheap = haiku");
  const quality = resolvePreset(CORE, roles, "claude-code", "quality");
  assert.equal(quality.modelByRole["boss-1"], "opus", "quality bosses = strong = opus");
  assert.equal(quality.modelByRole["developer-1"], "sonnet", "quality workers = mid = sonnet");
  const codex = resolvePreset(CORE, roles, "codex", "budget");
  assert.equal(codex.perRole, false, "codex uses one model per session");
  assert.ok(codex.sessionModel, "codex has a recommended session model");
  assert.throws(() => resolvePreset(CORE, roles, "claude-code", "nope"), /unknown model preset/);
});

test("adapter applies modelByRole to frontmatter; default install keeps manifest models", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-m1-"));
  try {
    const plan = resolvePreset(CORE, roles, "claude-code", "budget");
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: "# c\n", modelByRole: plan.modelByRole, preset: "budget", now: NOW });
    assert.match(readFileSync(join(t, ".claude", "agents", "developer-1.md"), "utf8"), /^model: haiku$/m, "worker → haiku");
    assert.match(readFileSync(join(t, ".claude", "agents", "boss-1.md"), "utf8"), /^model: sonnet$/m, "boss → mid tier");
    assert.equal(JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8")).preset, "budget");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("no preset → manifest defaults are untouched", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-m1-"));
  try {
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: "# c\n", now: NOW });
    assert.match(readFileSync(join(t, ".claude", "agents", "boss-1.md"), "utf8"), /^model: opus$/m, "default boss = opus");
    assert.match(readFileSync(join(t, ".claude", "agents", "developer-1.md"), "utf8"), /^model: sonnet$/m, "default worker = sonnet");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("cli: init --models budget, then `venom models quality` switches per-role models", () => {
  const t = mkdtempSync(join(tmpdir(), "venom-m1cli-"));
  try {
    const out = run(["init", "--dir", t, "--tool", "claude-code", "--pack", "solo-minimal", "--name", "X", "--models", "budget", "--yes"]);
    assert.match(out, /budget preset/);
    assert.match(readFileSync(join(t, ".claude", "agents", "developer-1.md"), "utf8"), /^model: haiku$/m, "budget worker = haiku");

    const list = run(["models"]);
    for (const p of ["quality", "balanced", "budget"]) assert.match(list, new RegExp(p));

    run(["models", "quality", "--dir", t]);
    assert.match(readFileSync(join(t, ".claude", "agents", "developer-1.md"), "utf8"), /^model: sonnet$/m, "quality worker = sonnet");
    assert.equal(JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8")).preset, "quality", "preset updated");
  } finally { rmSync(t, { recursive: true, force: true }); }
});
