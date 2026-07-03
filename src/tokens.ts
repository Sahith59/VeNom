// `venom tokens` — a static, zero-dependency estimate of Venom's token footprint.
// It measures the real sizes of the specs, charter, and memory scaffold that get loaded when the team
// runs, using a char/4 proxy (the same methodology AgentMem-OS uses: len(text)//4). The point is a
// reproducible baseline + a cost table across models, so every later optimization can be measured.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bold, dim } from "./style.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Packs = any;

const CHARS_PER_TOKEN = 4;

export function estTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function fileTok(p: string): number {
  try {
    return estTokens(readFileSync(p, "utf8"));
  } catch {
    return 0;
  }
}

function mean(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function usd(n: number): string {
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

interface Rates {
  asOf: string;
  cacheReadFactor: number;
  models: Record<string, { label: string; inputPerMTok: number }>;
}

export interface Estimate {
  pack: string;
  roleCount: number;
  avgSpec: number;
  maxSpec: number;
  biggestRole: string;
  charter: number;
  memoryRead: number;
  perTurn: number;
  turnsPerGoal: number;
  perGoal: number;
}

export function estimatePack(coreDir: string, packs: Packs, pack: string): Estimate {
  const roles: string[] = [...packs.core, ...packs.packs[pack].adds];
  const specs = roles.map((r) => ({ role: r, tok: fileTok(join(coreDir, "agents", `${r}.md`)) }));
  const toks = specs.map((s) => s.tok);
  const biggest = specs.slice().sort((a, b) => b.tok - a.tok)[0]!;

  const charter = fileTok(join(coreDir, "CHARTER_TEMPLATE.md"));
  const snapshot = fileTok(join(coreDir, "memory-template", "SNAPSHOT.md"));
  const slice =
    fileTok(join(coreDir, "memory-template", "dev", "log.md")) +
    fileTok(join(coreDir, "memory-template", "lessons", "dev.md"));

  const avgSpec = mean(toks);
  const memoryRead = snapshot + slice;
  const perTurn = avgSpec + charter + memoryRead;
  // Heuristic fan-out: a typical goal engages ~70% of the team, ~1.4 turns each (review loops).
  const turnsPerGoal = Math.max(4, Math.round(roles.length * 0.7 * 1.4));

  return {
    pack,
    roleCount: roles.length,
    avgSpec,
    maxSpec: Math.max(...toks),
    biggestRole: biggest.role,
    charter,
    memoryRead,
    perTurn,
    turnsPerGoal,
    perGoal: perTurn * turnsPerGoal,
  };
}

export function renderTokens(coreDir: string, packs: Packs, pack: string): string {
  const rates: Rates = JSON.parse(readFileSync(join(coreDir, "model-rates.json"), "utf8"));
  const e = estimatePack(coreDir, packs, pack);
  const L: string[] = [];

  L.push("");
  L.push(bold(`  Venom token estimate — ${packs.packs[pack].name} pack (${e.roleCount} agents)`));
  L.push(dim(`  Input tokens, ~${CHARS_PER_TOKEN} chars/token proxy. Recurring framework overhead per agent turn:`));
  L.push("");
  L.push(`  ${dim("spec (avg)".padEnd(18))} ~${fmt(e.avgSpec)}   ${dim(`(biggest: ${e.biggestRole} ~${fmt(e.maxSpec)})`)}`);
  L.push(`  ${dim("charter".padEnd(18))} ~${fmt(e.charter)}`);
  L.push(`  ${dim("memory read".padEnd(18))} ~${fmt(e.memoryRead)}   ${dim("(SNAPSHOT + a slice — grows as the project grows)")}`);
  L.push(`  ${bold("per-turn overhead".padEnd(18))} ~${fmt(e.perTurn)}`);
  L.push("");
  L.push(bold("  Per goal") + dim(` (~${e.turnsPerGoal} agent turns — heuristic: 70% of the team × 1.4 for review loops):`));
  L.push(`  ~${fmt(e.perGoal)} tokens of framework scaffolding` + dim("  (+ your actual code/work on top)"));
  L.push("");
  L.push(bold(`  Indicative cost per goal (scaffolding input only, prices as of ${rates.asOf}):`));
  const cacheMix = 0.3 + 0.7 * rates.cacheReadFactor; // assume ~70% of input is a cacheable stable prefix
  for (const m of Object.values(rates.models)) {
    const full = (e.perGoal / 1_000_000) * m.inputPerMTok;
    const cached = full * cacheMix;
    L.push(`  ${dim(m.label.padEnd(18))} ${usd(full).padStart(9)}   ${dim(`with prompt caching ~${usd(cached)}`)}`);
  }
  L.push("");
  L.push(dim("  Estimates use a char/4 proxy; prices are directional (edit core/model-rates.json)."));
  L.push(dim("  Run before/after a change to see the delta — that's what this is for."));
  L.push("");
  return L.join("\n");
}
