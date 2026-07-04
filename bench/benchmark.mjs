// Rerunnable token benchmark for Venom (M5 — "prove it").
//
// Measures each token/cost lever before/after, from source, so every number in the README's
// "Token efficiency" section is reproducible and honest — no hand-written figures.
//
//   node bench/benchmark.mjs           # human-readable table + writes bench/token-savings.json
//   node bench/benchmark.mjs --json    # machine-readable only
//
// Requires a prior build (dist/). Levers:
//   1. Model selection (M1)  — same tokens, cheaper models: $/goal per preset (from shipped presets/rates).
//   2. Lean specs (M2)       — trimmed vs pre-trim spec tokens (pre-trim read from git @ 908d27e~1).
//   3. Memory compaction (M3)— hot read-path tokens before/after compaction on a synthetic growing project.
//
// Honesty: char/4 token proxy (indicative, not a real tokenizer); prices are directional (model-rates.json);
// Venom does not own the LLM call, so these are context-size and cost bounds, not inference-time reductions.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CORE = join(ROOT, "core");
const DIST = join(ROOT, "dist");

const { estTokens, estimatePack } = await import(join(DIST, "tokens.js"));
const { loadModels, resolvePreset } = await import(join(DIST, "models.js"));
const { planCompact, parseLog } = await import(join(DIST, "memory.js"));

const packs = JSON.parse(readFileSync(join(CORE, "packs.json"), "utf8"));
const rates = JSON.parse(readFileSync(join(CORE, "model-rates.json"), "utf8"));
const models = loadModels(CORE);

const PACK = "web-app"; // the pack used for the M0 baseline
const jsonOnly = process.argv.includes("--json");
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pct = (from, to) => (from > 0 ? Math.round(((from - to) / from) * 1000) / 10 : 0);
const usd = (n) => (n < 0.01 ? "$" + n.toFixed(4) : n < 1 ? "$" + n.toFixed(3) : "$" + n.toFixed(2));

// ── Lever 1: model selection (cost) ──────────────────────────────────────────
function leverModel() {
  const est = estimatePack(CORE, packs, PACK);
  const roles = [...packs.core, ...packs.packs[PACK].adds];
  const presets = {};
  for (const name of Object.keys(models.presets)) {
    const plan = resolvePreset(CORE, roles, "claude-code", name);
    const blended =
      roles.reduce((s, r) => {
        const tier = plan.tierByRole[r];
        if (!tier) throw new Error(`benchmark: no tier for role "${r}" in preset "${name}"`);
        const rate = rates.models[models.tierRateKey[tier]]?.inputPerMTok;
        if (rate == null) throw new Error(`benchmark: no input rate for tier "${tier}" (rate key "${models.tierRateKey[tier]}")`);
        return s + rate;
      }, 0) / roles.length;
    presets[name] = { costPerGoalUsd: (est.perGoal / 1_000_000) * blended, blendedInputPerMTok: Math.round(blended * 1000) / 1000 };
  }
  const q = presets.quality?.costPerGoalUsd ?? 0;
  const b = presets.budget?.costPerGoalUsd ?? 0;
  const def = presets[models.defaultPreset]?.costPerGoalUsd ?? 0;
  return {
    pack: PACK,
    perGoalTokens: est.perGoal,
    defaultPreset: models.defaultPreset,
    presets,
    budgetVsQualityPctCheaper: pct(q, b),
    budgetVsDefaultPctCheaper: pct(def, b),
  };
}

// ── Lever 2: lean specs (context tokens), current vs pre-trim from git ────────
const TRIM_COMMIT = "908d27e"; // "perf(specs): trim all 23 agent specs"
function leverSpecTrim() {
  const roles = [...packs.core, ...packs.packs[PACK].adds];
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const after = roles.map((r) => estTokens(readFileSync(join(CORE, "agents", `${r}.md`), "utf8")));
  const est = estimatePack(CORE, packs, PACK);
  const avgSpecAfter = Math.round(sum(after) / after.length);

  // Read every pre-trim spec from git. If ANY role's history is missing (shallow clone / not a repo),
  // skip the whole lever rather than mixing real deltas with zero-delta fallbacks (which would silently
  // understate the reduction). All-or-nothing keeps the reported numbers honest.
  const before = [];
  let available = true;
  for (const r of roles) {
    try {
      before.push(estTokens(execFileSync("git", ["show", `${TRIM_COMMIT}~1:core/agents/${r}.md`], { cwd: ROOT, encoding: "utf8" })));
    } catch {
      available = false;
      break;
    }
  }
  if (!available) {
    return {
      available: false,
      note: "git history unavailable (shallow clone or not a repo) — spec-trim delta skipped",
      specsTotalBefore: null, specsTotalAfter: sum(after),
      avgSpecBefore: null, avgSpecAfter, avgSpecPctSmaller: null,
      perTurnBefore: null, perTurnAfter: est.perTurn, perTurnPctSmaller: null,
      perGoalBefore: null, perGoalAfter: est.perTurn * est.turnsPerGoal,
    };
  }
  const avgBefore = Math.round(sum(before) / before.length);
  const perTurnBefore = est.perTurn - est.avgSpec + avgBefore; // only the avg-spec term differs pre-trim
  const perTurnAfter = est.perTurn; // estimator already reflects the trimmed specs
  return {
    available: true,
    specsTotalBefore: sum(before), specsTotalAfter: sum(after),
    avgSpecBefore: avgBefore, avgSpecAfter, avgSpecPctSmaller: pct(avgBefore, avgSpecAfter),
    perTurnBefore, perTurnAfter, perTurnPctSmaller: pct(perTurnBefore, perTurnAfter),
    perGoalBefore: perTurnBefore * est.turnsPerGoal, perGoalAfter: perTurnAfter * est.turnsPerGoal,
  };
}

// ── Lever 3: memory compaction (hot read-path tokens), synthetic growing project ─
// A representative log entry in the documented format (~fixed size so results are deterministic).
function makeEntry(i) {
  const d = new Date(2025, 0, 1 + (i % 360));
  const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 09:${String(i % 60).padStart(2, "0")}`;
  return (
    `### [${ts}] developer-1 — implement feature ${i} and wire it through the adapter\n` +
    `- **Task:** build surface ${i} to the definition of done, covering the error paths and the load case.\n` +
    `- **Did:** added the module, the tests, and the integration glue; ran the suite green and checked the edge cases by hand.\n` +
    `- **Result:** shipped; the suite passes and the debugger signed off on durability for the long-term path.\n` +
    `- **Refs:** src/feature-${i}.ts, test/feature-${i}.test.ts; built on ADR-${i % 7} and lesson dev-${i % 5}.\n` +
    `- **Next / who needs to know:** testing to extend coverage; review to gate before the next release.\n`
  );
}
function buildLog(n) {
  let s = "# dev team — log (append-only)\n\n> Every meaningful action, newest last.\n\n---\n";
  for (let i = 1; i <= n; i++) s += "\n" + makeEntry(i);
  return s;
}
function leverCompaction() {
  const KEEP = JSON.parse(readFileSync(join(CORE, "memory-budgets.json"), "utf8")).hotLogEntries ?? 20;
  const snapshot = estTokens(readFileSync(join(CORE, "memory-template", "SNAPSHOT.md"), "utf8"));
  const lessons = estTokens(readFileSync(join(CORE, "memory-template", "lessons", "dev.md"), "utf8"));
  const entryTok = estTokens(makeEntry(1));
  const scales = [50, 200, 550];
  const rows = [];
  for (const n of scales) {
    const log = buildLog(n); // pure in-memory; planCompact/parseLog never touch disk
    const p = planCompact(log, { keep: KEEP });
    // true byte-exact check: preamble + archived(oldest) + kept(newest) must reconstruct the original,
    // and the newest KEEP entries stay hot — nothing dropped, nothing duplicated.
    const preamble = parseLog(log).preamble;
    const keptPart = p.remaining.slice(preamble.length);
    const reconstructed = preamble + p.archivedEntries + keptPart;
    const okBytes = reconstructed === log && p.keptCount === Math.min(n, KEEP) && p.movedCount === Math.max(0, n - KEEP);
    const logBefore = estTokens(log);
    const logAfter = estTokens(p.remaining);
    const hotBefore = snapshot + logBefore + lessons;
    const hotAfter = snapshot + logAfter + lessons;
    rows.push({
      entries: n,
      keep: KEEP,
      archived: p.movedCount,
      logTokBefore: logBefore,
      logTokAfter: logAfter,
      hotReadPathBefore: hotBefore,
      hotReadPathAfter: hotAfter,
      hotPctSmaller: pct(hotBefore, hotAfter),
      byteExactOk: okBytes,
    });
  }
  return { keep: KEEP, entryTok, snapshotTok: snapshot, lessonsTok: lessons, scales: rows };
}

const result = {
  generatedAt: new Date().toISOString(),
  methodology: {
    tokenProxy: "char/4 (indicative; not an exact tokenizer)",
    prices: `directional, from core/model-rates.json (asOf ${rates.asOf})`,
    pack: PACK,
    boundary:
      "Venom does not own the LLM call. Model selection lowers COST for the same tokens; lean specs lower the per-turn CONTEXT the agents read; compaction BOUNDS memory growth. None reduce tokens the model spends at inference.",
  },
  levers: {
    modelSelection: leverModel(),
    leanSpecs: leverSpecTrim(),
    memoryCompaction: leverCompaction(),
  },
};

writeFileSync(join(HERE, "token-savings.json"), JSON.stringify(result, null, 2) + "\n");

if (!jsonOnly) {
  const m = result.levers.modelSelection;
  const s = result.levers.leanSpecs;
  const c = result.levers.memoryCompaction;
  const line = (a, b) => `  ${String(a).padEnd(38)} ${b}`;
  console.log(`\n  Venom token benchmark — ${PACK} pack   (char/4 proxy · prices asOf ${rates.asOf})`);
  console.log(`  ${"─".repeat(70)}`);
  console.log(`\n  1. Model selection (cost) — same ${fmt(m.perGoalTokens)} tokens/goal, cheaper models:`);
  for (const [name, v] of Object.entries(m.presets)) {
    console.log(line(`     ${name}${name === models.defaultPreset ? " (default)" : ""}`, `${usd(v.costPerGoalUsd)}/goal`));
  }
  console.log(line(`     → budget vs ${m.defaultPreset} (default)`, `${m.budgetVsDefaultPctCheaper}% cheaper`));
  console.log(line("     → budget vs quality", `${m.budgetVsQualityPctCheaper}% cheaper`));

  console.log(`\n  2. Lean specs (context) — trimmed vs pre-trim (git @ ${TRIM_COMMIT}~1):`);
  if (s.available) {
    console.log(line("     avg spec", `${fmt(s.avgSpecBefore)} → ${fmt(s.avgSpecAfter)} tok  (${s.avgSpecPctSmaller}% smaller)`));
    console.log(line("     per-turn overhead", `${fmt(s.perTurnBefore)} → ${fmt(s.perTurnAfter)} tok  (${s.perTurnPctSmaller}% smaller)`));
    console.log(line("     per-goal scaffolding", `${fmt(s.perGoalBefore)} → ${fmt(s.perGoalAfter)} tok`));
  } else {
    console.log(`     (skipped — ${s.note})`);
  }

  console.log(`\n  3. Memory compaction (hot read-path) — keep newest ${c.keep}, archive the rest:`);
  console.log(line("     project size", "hot read-path before → after"));
  for (const r of c.scales) {
    console.log(line(`     ${r.entries} log entries`, `${fmt(r.hotReadPathBefore)} → ${fmt(r.hotReadPathAfter)} tok  (${r.hotPctSmaller}% smaller)`));
  }
  const allByteOk = c.scales.every((r) => r.byteExactOk);
  console.log(`\n  compaction byte-exact check: ${allByteOk ? "PASS (archived + kept = original, nothing lost)" : "FAIL"}`);
  console.log(`\n  Wrote bench/token-savings.json · rerun: node bench/benchmark.mjs`);
  console.log("");
}

// Fail the process (both --json and default) if compaction ever loses/dupes an entry — the whole point
// of the benchmark is that these numbers are trustworthy.
if (!result.levers.memoryCompaction.scales.every((r) => r.byteExactOk)) {
  process.stderr.write("benchmark: compaction byte-exact check FAILED — refusing to certify the numbers\n");
  process.exit(1);
}
