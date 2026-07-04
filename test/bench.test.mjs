// Guards the M5 token benchmark: it must run, emit well-formed savings JSON, and every measured
// invariant must hold (costs ordered, compaction byte-exact and monotonic). This keeps the numbers in
// the README honest — if a lever regresses, this fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("bench: benchmark runs and emits well-formed, honest savings JSON", () => {
  execFileSync(process.execPath, ["bench/benchmark.mjs", "--json"], { cwd: ROOT, encoding: "utf8" });
  const r = JSON.parse(readFileSync(join(ROOT, "bench", "token-savings.json"), "utf8"));

  assert.ok(!Number.isNaN(Date.parse(r.generatedAt)), "generatedAt is a real timestamp");
  assert.ok(r.methodology.tokenProxy.includes("char/4"), "methodology names the proxy");
  assert.ok(/does not own/i.test(r.methodology.boundary), "methodology states the honest boundary");

  // Lever 1 — cheaper models cost less for the same tokens. Direction AND magnitude (loose bounds so a
  // rate/spec edit doesn't break it, but a gross mispricing that kept the ordering would fail).
  const m = r.levers.modelSelection;
  assert.ok(m.presets.budget.costPerGoalUsd < m.presets.balanced.costPerGoalUsd, "budget < balanced");
  assert.ok(m.presets.balanced.costPerGoalUsd < m.presets.quality.costPerGoalUsd, "balanced < quality");
  assert.ok(m.budgetVsDefaultPctCheaper > 40 && m.budgetVsDefaultPctCheaper < 95, `budget-vs-default in range (got ${m.budgetVsDefaultPctCheaper})`);
  assert.ok(m.budgetVsQualityPctCheaper >= m.budgetVsDefaultPctCheaper, "vs quality is at least vs default");
  assert.ok(m.perGoalTokens > 10_000, "per-goal token base is realistic");

  // Lever 2 — trimmed specs are not larger than pre-trim (when git history is available).
  const s = r.levers.leanSpecs;
  if (s.available) {
    assert.ok(s.avgSpecAfter <= s.avgSpecBefore, "avg spec not larger after trim");
    assert.ok(s.perTurnAfter <= s.perTurnBefore, "per-turn not larger after trim");
    assert.ok(s.avgSpecPctSmaller > 0 && s.avgSpecPctSmaller < 40, `trim % in a modest, honest range (got ${s.avgSpecPctSmaller})`);
    assert.ok(s.specsTotalBefore > s.specsTotalAfter, "total spec tokens actually dropped");
  } else {
    // On a shallow clone the lever is skipped — the before-numbers must be null, never a mixed understatement.
    assert.equal(s.avgSpecBefore, null, "unavailable lever reports null before-numbers, not a fabricated 0-delta");
    assert.equal(s.perTurnBefore, null);
  }

  // Lever 3 — compaction is byte-exact at every scale and shrinks more as the project grows.
  const c = r.levers.memoryCompaction;
  assert.ok(c.scales.length >= 2, "multiple project sizes measured");
  for (const row of c.scales) {
    assert.equal(row.byteExactOk, true, `byte-exact at ${row.entries} entries (nothing lost)`);
    assert.ok(row.hotReadPathAfter <= row.hotReadPathBefore, "hot read-path not larger after compaction");
    assert.ok(row.hotPctSmaller >= 0 && row.hotPctSmaller <= 100, "sane reduction %");
  }
  const sorted = c.scales.slice().sort((a, b) => a.entries - b.entries);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].hotPctSmaller >= sorted[i - 1].hotPctSmaller, "bigger projects benefit at least as much");
  }
  assert.ok(sorted[sorted.length - 1].hotPctSmaller > 80, "the largest project sees a large read-path reduction");
});
