// Tests for `venom tokens` — the static token-footprint estimator. Requires a prior build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { estTokens, estimatePack } from "../dist/tokens.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const CORE = join(ROOT, "core");
const packs = JSON.parse(readFileSync(join(CORE, "packs.json"), "utf8"));

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

test("estTokens uses the char/4 proxy", () => {
  assert.equal(estTokens("aaaa"), 1);
  assert.equal(estTokens("a".repeat(4000)), 1000);
  assert.equal(estTokens(""), 0);
});

test("estimatePack is internally consistent and pack-sensitive", () => {
  const web = estimatePack(CORE, packs, "web-app");
  const solo = estimatePack(CORE, packs, "solo-minimal");
  assert.equal(web.roleCount, packs.core.length + packs.packs["web-app"].adds.length, "14 web-app roles");
  assert.equal(web.perGoal, web.perTurn * web.turnsPerGoal, "perGoal = perTurn × turnsPerGoal");
  assert.ok(web.perTurn > 0 && web.avgSpec > 0 && web.charter > 0, "components measured, non-zero");
  assert.ok(web.turnsPerGoal >= 4, "fan-out has a floor");
  assert.ok(web.perGoal > solo.perGoal, "the bigger pack costs more per goal");
});

test("cli tokens renders the estimate + cross-model cost table", () => {
  const out = run(["tokens", "--pack", "web-app"]);
  assert.match(out, /Venom token estimate — Web \/ App Development pack \(14 agents\)/);
  assert.match(out, /per-turn overhead/);
  assert.match(out, /Per goal/);
  assert.match(out, /Claude Opus/);
  assert.match(out, /Claude Haiku/);
  assert.match(out, /Gemini Flash/);
  assert.match(out, /with prompt caching/);
  assert.match(out, /~[\d,]+ tokens of framework scaffolding/);
});

test("cli tokens defaults to the default pack and rejects an unknown one", () => {
  const out = run(["tokens"]);
  assert.match(out, new RegExp(`\\(${packs.core.length + packs.packs[packs.defaultPack].adds.length} agents\\)`));
  let code = 0;
  try {
    run(["tokens", "--pack", "nope"]);
  } catch (e) {
    code = e.status;
  }
  assert.notEqual(code, 0, "unknown pack exits non-zero");
});
