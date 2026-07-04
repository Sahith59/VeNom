// The agent router: turns the coding tool's chat into a way to see and reach this project's team.
// It is a DIRECTORY + RANKER, not an intelligence — it reads the *actually installed* roster and the
// role specs on disk and does keyword/field-weighted matching. The host model is the intelligence; the
// tool just hands it the right persona. It cannot run an agent (an MCP is a passive tool provider).
//
// Pure functions here; src/mcp.ts wraps them as tools and does the one side effect (handoff's memory
// append). Kept separate so it's unit-testable without the JSON-RPC layer.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
// The team logs that exist under agent-memory/. A role's org "team" maps onto one of these for handoff
// logging; boss-1's "orchestration" has no log of its own, so boss-level dispatches land in review.
const LOG_TEAMS = new Set(["dev", "research", "review", "security"]);

// Read order for a readable roster/flow: the agent you talk to, then makers, then the gates.
const TEAM_ORDER: Record<string, number> = { orchestration: 0, research: 2, dev: 3, review: 4, security: 4 };

// Discriminative-enough short tokens we keep despite the length floor.
const SHORT_KEEP = new Set(["ml", "ci", "db", "ui", "ux", "qa", "js", "ts", "go"]);
// Words that don't tell one role from another — generic build verbs and English filler. Dropped so the
// score reflects the specialty, not the fact that every spec says "build". NOT stopped: test, design,
// security, research, debug, document, data, model, review — those DO point at a role.
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "for", "in", "on", "with", "without", "into", "from",
  "as", "at", "by", "so", "then", "this", "that", "these", "those", "it", "its", "is", "are", "be", "was",
  "were", "our", "my", "we", "you", "your", "i", "me", "us", "they", "them", "not", "no", "yes", "can",
  "could", "should", "would", "will", "shall", "may", "might", "do", "does", "did", "done", "need", "needs",
  "want", "wants", "please", "help", "let", "lets", "up", "out", "off", "all", "any", "some", "new", "old",
  "add", "adds", "added", "adding", "make", "makes", "made", "making", "build", "builds", "built", "building",
  "create", "creates", "created", "creating", "implement", "implements", "write", "writes", "writing",
  "use", "uses", "using", "get", "gets", "set", "sets", "run", "runs", "have", "has", "had", "about",
  "project", "app", "thing", "stuff", "work", "works", "task", "tasks",
]);

export interface RosterRole {
  role: string;
  title: string;
  summary: string;
  team: string;
}

export interface Roster {
  tool: string;
  pack: string;
  roles: RosterRole[];
}

interface PacksFile {
  core: string[];
  roles: Record<string, { team?: string; title?: string; summary?: string; reportsTo?: string; optional?: boolean }>;
  packs: Record<string, { adds: string[] }>;
}

function loadPacks(coreDir: string): PacksFile {
  return JSON.parse(readFileSync(join(coreDir, "packs.json"), "utf8")) as PacksFile;
}

function roleInfo(packs: PacksFile, role: string): RosterRole {
  const r = packs.roles[role] ?? {};
  return { role, title: r.title ?? role, summary: r.summary ?? "", team: r.team ?? "dev" };
}

function orderRoles(a: RosterRole, b: RosterRole): number {
  if (a.role === "boss-1") return -1;
  if (b.role === "boss-1") return 1;
  const ta = TEAM_ORDER[a.team] ?? 3;
  const tb = TEAM_ORDER[b.team] ?? 3;
  return ta !== tb ? ta - tb : a.role.localeCompare(b.role);
}

// The one source of truth for "what is actually installed here": the install record `venom init`/`add`
// maintain. Reading it (not a hardcoded pack) is what makes a custom --roles roster route correctly.
export function loadRoster(coreDir: string, projectDir: string): Roster {
  const recPath = join(projectDir, ".venom", "install.json");
  if (!existsSync(recPath)) {
    throw new Error("No Venom install here (.venom/install.json missing). Run `venom init` first, or start the server from the project root (or with --dir).");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recPath, "utf8"));
  } catch {
    throw new Error(".venom/install.json is present but unreadable (invalid JSON). Re-run `venom init` to repair it.");
  }
  // A record that parses to null / a number / an array isn't a valid install — reject it with the same
  // clean message rather than letting `parsed.roles` throw an opaque TypeError.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".venom/install.json is present but not a valid install record (expected a JSON object). Re-run `venom init` to repair it.");
  }
  const rec = parsed as { tool?: string; pack?: string; roles?: unknown };
  const packs = loadPacks(coreDir);
  const raw = Array.isArray(rec.roles) ? rec.roles : [];
  const seen = new Set<string>();
  const roles = raw
    .filter((r): r is string => typeof r === "string" && SAFE_SLUG.test(r) && Boolean(packs.roles[r]))
    .filter((r) => (seen.has(r) ? false : (seen.add(r), true))) // a tampered install.json can't list a role twice
    .map((r) => roleInfo(packs, r))
    .sort(orderRoles);
  return { tool: typeof rec.tool === "string" ? rec.tool : "claude-code", pack: typeof rec.pack === "string" ? rec.pack : "", roles };
}

export interface Brief {
  role: string;
  title: string;
  summary: string;
  team: string;
  reportsTo: string;
  installed: boolean;
  body: string;
}

// Full persona spec for one role. The adapter installs exactly this body (it only prepends per-tool
// frontmatter), so returning the core spec is honest about who the installed agent is.
export function agentBrief(coreDir: string, projectDir: string, role: string): Brief {
  if (typeof role !== "string" || !SAFE_SLUG.test(role)) throw new Error(`invalid role "${role}"`);
  const packs = loadPacks(coreDir);
  const meta = packs.roles[role];
  const specPath = join(coreDir, "agents", `${role}.md`);
  if (!meta || !existsSync(specPath)) {
    throw new Error(`unknown role "${role}". Call list_agents to see the installed roster.`);
  }
  let installed = false;
  try {
    installed = loadRoster(coreDir, projectDir).roles.some((r) => r.role === role);
  } catch {
    /* no install record — report the spec anyway, installed stays false */
  }
  return {
    role,
    title: meta.title ?? role,
    summary: meta.summary ?? "",
    team: meta.team ?? "dev",
    reportsTo: meta.reportsTo ?? "boss-1",
    installed,
    body: readFileSync(specPath, "utf8").replace(/^﻿/, "").trimEnd(),
  };
}

// First real paragraph of a spec (the mandate), for a compact route result. Skips the H1 and any lead
// blank lines; stops at the first blank line after prose starts.
function openingParagraph(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (out.length === 0) {
      if (!t || t.startsWith("#")) continue; // skip the title + leading blanks
      out.push(t);
    } else {
      if (!t) break;
      out.push(t);
    }
  }
  const para = out.join(" ").replace(/\s+/g, " ").trim();
  return para.length > 320 ? para.slice(0, 317).replace(/\s+\S*$/, "") + "…" : para;
}

// route scores O(terms × roles × fields) regex scans, and each term compiles a RegExp, and the server
// is single-threaded — so an unbounded task would let one call hang the whole server (and a giant single
// token would even throw "regex too large"). Bound all three: clip the task, cap distinct terms, and
// skip pathological tokens. A real task has far fewer than 160 content words.
const MAX_TASK_CHARS = 20_000;
const MAX_TERMS = 160;
const MAX_TERM_LEN = 48;

function tokenize(task: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of String(task).slice(0, MAX_TASK_CHARS).toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length > MAX_TERM_LEN) continue; // skip empties and blob/URL tokens
    if (STOP.has(raw)) continue;
    if (raw.length < 3 && !SHORT_KEEP.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

// Whole-word prefix matcher for one term: \bterm\w*  — "test" hits test/tests/testing/tester but not
// "attest". Regex metachars can't appear (tokens are [a-z0-9]) so no escaping needed.
function countMatches(field: string, term: string, cap: number): number {
  const re = new RegExp(`\\b${term}[a-z0-9]*`, "g");
  let n = 0;
  while (re.exec(field) !== null) {
    if (++n >= cap) break;
  }
  return n;
}

const W = { title: 6, summary: 4, team: 3, name: 3, body: 1 } as const;
const BODY_CAP = 3; // one word repeated across a long spec can't dominate the score

interface Scored {
  role: string;
  title: string;
  summary: string;
  team: string;
  score: number;
  matched: string[];
  why: string;
}

function scoreRole(terms: string[], info: RosterRole, body: string): Scored {
  const nameField = info.role.replace(/-/g, " ");
  const title = info.title.toLowerCase();
  const summary = info.summary.toLowerCase();
  const team = info.team.toLowerCase();
  const name = nameField.toLowerCase();
  const bodyLc = body.toLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const term of terms) {
    let hitHere = 0;
    hitHere += W.title * countMatches(title, term, 2);
    hitHere += W.summary * countMatches(summary, term, 3);
    hitHere += W.team * countMatches(team, term, 1);
    hitHere += W.name * countMatches(name, term, 1);
    hitHere += W.body * countMatches(bodyLc, term, BODY_CAP);
    if (hitHere > 0) {
      score += hitHere + 2; // coverage bonus: a role touching more distinct task words wins ties
      matched.push(term);
    }
  }
  return { role: info.role, title: info.title, summary: info.summary, team: info.team, score, matched, why: matched.join(", ") };
}

// A cheap surface score (no spec body) over EVERY known role — used only to notice when the strongest
// fit is a role the user didn't install, so route can honestly suggest `venom add`.
function surfaceScore(terms: string[], info: RosterRole): number {
  let s = 0;
  for (const term of terms) {
    s += W.title * countMatches(info.title.toLowerCase(), term, 2);
    s += W.summary * countMatches(info.summary.toLowerCase(), term, 3);
    s += W.team * countMatches(info.team.toLowerCase(), term, 1);
    s += W.name * countMatches(info.role.replace(/-/g, " ").toLowerCase(), term, 1);
  }
  return s;
}

export interface RouteResult {
  task: string;
  terms: string[];
  candidates: Array<{ role: string; title: string; summary: string; team: string; score: number; matched: string[]; brief: string }>;
  flow: Array<{ role: string; title: string; note: string }>;
  missingTip?: { role: string; title: string };
  installedCount: number;
}

// Rank the INSTALLED roster against a plain-English task, then lay the top picks onto Venom's standard
// pass (BOSS-1 scopes → specialists make → gates review). Deterministic: same task + roster => same result.
export function routeTask(coreDir: string, projectDir: string, task: string, opts: { limit?: number } = {}): RouteResult {
  if (typeof task !== "string" || !task.trim()) throw new Error("task is required");
  const roster = loadRoster(coreDir, projectDir);
  const terms = tokenize(task);
  const limit = Math.max(1, Math.min(6, Number.isInteger(opts.limit) ? (opts.limit as number) : 3));

  const scored = roster.roles
    .map((info) => {
      const body = safeReadSpec(coreDir, info.role);
      return { info, s: scoreRole(terms, info, body) };
    })
    .filter((x) => x.s.score > 0)
    .sort((a, b) => (b.s.score !== a.s.score ? b.s.score - a.s.score : orderRoles(a.info, b.info)));

  const top = scored.slice(0, limit);
  const candidates = top.map((x) => ({
    role: x.s.role,
    title: x.s.title,
    summary: x.s.summary,
    team: x.s.team,
    score: x.s.score,
    matched: x.s.matched,
    brief: openingParagraph(safeReadSpec(coreDir, x.s.role)),
  }));

  // The suggested pass: BOSS-1 always opens; the matched makers run in team order; the always-on gates
  // (whichever are installed) close it. Gates that also matched the keywords aren't listed twice.
  const flow: Array<{ role: string; title: string; note: string }> = [];
  const has = (r: string): RosterRole | undefined => roster.roles.find((x) => x.role === r);
  const opener = has("boss-1");
  if (opener) flow.push({ role: opener.role, title: opener.title, note: "scope the task and split it into bounded work" });
  // boss-1 always opens and the review gates always close, so exclude BOTH from the makers — otherwise
  // boss-1 gets emitted a second time (and mislabeled "do the work"), or a matched gate lands in the
  // wrong slot.
  const closers = new Set(["boss-1", "boss-2", "critics", "security"]);
  const makers = top.map((x) => x.info).filter((x) => !closers.has(x.role)).sort(orderRoles);
  for (const m of makers) flow.push({ role: m.role, title: m.title, note: "do the work" });
  // critics + security are the always-on review gates. boss-2 (independent auditor) is NOT always-on —
  // include it only when it actually matched the task, so the flow never contradicts the ranking.
  const matched = new Set(top.map((x) => x.s.role));
  for (const g of ["boss-2", "critics", "security"]) {
    const gi = has(g);
    if (!gi) continue;
    if (g === "boss-2" && !matched.has("boss-2")) continue;
    const note = g === "boss-2" ? "independent second opinion before the call is final" : "review before it's called done (read-only gate)";
    flow.push({ role: gi.role, title: gi.title, note });
  }

  // Would a role you didn't install fit better? Compare cheap surface scores across the whole catalog.
  let missingTip: { role: string; title: string } | undefined;
  if (terms.length) {
    const packs = loadPacks(coreDir);
    const installedSet = new Set(roster.roles.map((r) => r.role));
    const topInstalledSurface = roster.roles.reduce((mx, r) => Math.max(mx, surfaceScore(terms, r)), 0);
    let best: { role: string; title: string; score: number } | undefined;
    for (const role of Object.keys(packs.roles)) {
      if (installedSet.has(role)) continue;
      const info = roleInfo(packs, role);
      const s = surfaceScore(terms, info);
      if (s > 0 && (!best || s > best.score)) best = { role, title: info.title, score: s };
    }
    if (best && best.score > topInstalledSurface) missingTip = { role: best.role, title: best.title };
  }

  // Echo a clipped task — never reflect a huge blob back into the tool output.
  const taskEcho = task.length > 160 ? task.slice(0, 157).replace(/\s+\S*$/, "") + "…" : task;
  return { task: taskEcho, terms, candidates, flow, missingTip, installedCount: roster.roles.length };
}

const specCache = new Map<string, string>();
function safeReadSpec(coreDir: string, role: string): string {
  const key = `${coreDir}::${role}`;
  const hit = specCache.get(key);
  if (hit !== undefined) return hit;
  let body = "";
  try {
    if (SAFE_SLUG.test(role)) body = readFileSync(join(coreDir, "agents", `${role}.md`), "utf8").replace(/^﻿/, "");
  } catch {
    body = "";
  }
  specCache.set(key, body);
  return body;
}

// Which team log a handoff to `role` belongs in. boss-level/orchestration dispatches have no log of
// their own, so they land in review (where the bosses' decisions live).
export function logTeamForRole(coreDir: string, role: string): string {
  const packs = loadPacks(coreDir);
  const team = packs.roles[role]?.team ?? "";
  return LOG_TEAMS.has(team) ? team : "review";
}
