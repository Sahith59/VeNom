// `venom memory` — inspect, bound, and index the team's shared memory (`agent-memory/`).
//
// The honest boundary: Venom does not own the LLM call, so this cannot reduce tokens at inference.
// What it does is keep the on-disk memory the agents are asked to read *bounded and navigable*:
//   stats   — where the memory tokens actually are (hot read-path vs. cold archives).
//   compact — move old team-log entries out of the hot log into a verbatim archive (never deletes).
//   index   — regenerate INDEX.md's entry catalog so agents scan an index instead of whole logs.
// Compaction is byte-exact, archive-not-delete, dry-run by default, and idempotent.
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, renameSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { bold, dim, green, yellow, cyan } from "./style.js";
import { estTokens } from "./tokens.js";

export interface Budgets {
  hotLogEntries: number;
  budgetsTok: Record<string, number>;
}

const DEFAULT_BUDGETS: Budgets = {
  hotLogEntries: 20,
  budgetsTok: { "SNAPSHOT.md": 1600, log: 2500, distilled: 2200, lessons: 1600 },
};

export function loadBudgets(coreDir: string): Budgets {
  try {
    const b = JSON.parse(readFileSync(join(coreDir, "memory-budgets.json"), "utf8"));
    return { hotLogEntries: b.hotLogEntries ?? DEFAULT_BUDGETS.hotLogEntries, budgetsTok: b.budgetsTok ?? DEFAULT_BUDGETS.budgetsTok };
  } catch {
    return DEFAULT_BUDGETS;
  }
}

// ---------------------------------------------------------------------------
// Log parsing — split a log into its preamble and its `### ` entries, byte-exact.
// `### ` headers inside an HTML comment (the template's example entry) are NOT entries.
// ---------------------------------------------------------------------------

export interface LogParse {
  preamble: string;
  entries: string[];
}

// Line-anchored HTML comment blocks (the template's delete-me example entry lives in one). Anchoring
// `<!--` to the start of a line keeps a stray `<!--` mid-prose from pairing with a later `-->`.
function commentRanges(s: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /^[ \t]*<!--[\s\S]*?-->/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

// A real entry header starts a new top-level block, so it is preceded by a blank line (or is the very
// start of the file). A header QUOTED inside another entry's body follows prose on the previous line,
// not a blank line — which is exactly how we avoid tearing a cited `### [..]` out of its entry.
function precededByBlankLine(content: string, p: number): boolean {
  if (p === 0) return true;
  if (content[p - 1] !== "\n") return false;
  let j = p - 2;
  while (j >= 0 && content[j] !== "\n") j--;
  return content.slice(j + 1, p - 1).trim() === "";
}

export function parseLog(content: string): LogParse {
  const comments = commentRanges(content);
  const inComment = (pos: number): boolean => comments.some(([a, b]) => pos >= a && pos < b);
  // A real entry is the documented header `### [YYYY-MM-DD H:MM[:SS]] <agent> — <title>` at column 0,
  // starting a new block (preceded by a blank line) and not inside an HTML comment. The timestamp is
  // tolerant of a single-digit hour and optional seconds (agents write both). A `### [..]` line that
  // is NOT a blank-line-separated block — e.g. a header quoted inside a body — is left glued to its
  // entry: never split, never torn, never lost (at worst that entry is not independently compacted).
  const re = /^### \[\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?\]/gm;
  const heads: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (precededByBlankLine(content, m.index) && !inComment(m.index)) heads.push(m.index);
  }
  if (heads.length === 0) return { preamble: content, entries: [] };
  const preamble = content.slice(0, heads[0]);
  const bounds = [...heads, content.length];
  const entries: string[] = [];
  for (let i = 0; i < heads.length; i++) entries.push(content.slice(bounds[i]!, bounds[i + 1]!));
  return { preamble, entries };
}

// ---------------------------------------------------------------------------
// Compaction — pure plan (no fs). Keep the newest entries hot; archive the rest.
// ---------------------------------------------------------------------------

export interface CompactPlan {
  total: number;
  keptCount: number;
  movedCount: number;
  freedTok: number;
  remaining: string;
  archivedEntries: string;
}

export function planCompact(content: string, opts: { keep?: number; budgetTok?: number }): CompactPlan {
  const { preamble, entries } = parseLog(content);
  let keepCount: number;
  if (opts.budgetTok != null) {
    let tok = 0;
    keepCount = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const t = estTokens(entries[i]!);
      if (keepCount > 0 && tok + t > opts.budgetTok) break;
      tok += t;
      keepCount++;
    }
  } else {
    keepCount = Math.max(0, Math.floor(opts.keep ?? DEFAULT_BUDGETS.hotLogEntries));
  }
  keepCount = Math.min(keepCount, entries.length);
  if (entries.length === 0 || entries.length <= keepCount) {
    return { total: entries.length, keptCount: entries.length, movedCount: 0, freedTok: 0, remaining: content, archivedEntries: "" };
  }
  const moved = entries.slice(0, entries.length - keepCount);
  const kept = entries.slice(entries.length - keepCount);
  const archivedEntries = moved.join("");
  const remaining = preamble + kept.join("");
  return {
    total: entries.length,
    keptCount: kept.length,
    movedCount: moved.length,
    freedTok: estTokens(archivedEntries),
    remaining,
    archivedEntries,
  };
}

function archiveHeader(team: string): string {
  return (
    `# ${team} — log archive (cold storage, not in the hot read path)\n\n` +
    `> Older entries moved out of \`log.md\` by \`venom memory compact\`, appended in order and preserved\n` +
    `> verbatim. Agents do not read this in the normal path; it exists for audit and recovery.\n\n---\n\n`
  );
}

// ---------------------------------------------------------------------------
// Filesystem walk + categorization
// ---------------------------------------------------------------------------

export interface MemFile {
  abs: string;
  rel: string;
  tok: number;
  category: string;
  entries: number | null;
}

const HOT_CATEGORIES = new Set(["snapshot", "distilled", "log", "lessons", "index", "decisions"]);

function categorize(rel: string): string {
  const base = basename(rel);
  if (base === "SNAPSHOT.md") return "snapshot";
  if (base === "INDEX.md") return "index";
  if (base === "README.md") return "readme";
  if (base === "log.archive.md") return "archive";
  if (base === "log.md") return "log";
  if (rel.includes("/lessons/") || rel.startsWith("lessons/")) return "lessons";
  if (rel.includes("/adr/") || rel.startsWith("adr/")) return "adr";
  if (rel.includes("/decisions/") || rel.startsWith("decisions/")) return "decisions";
  if (["architecture.md", "knowledge.md", "threat-models.md"].includes(base)) return "distilled";
  return "other";
}

// Uses lstat and skips symlinks: never follow a link out of agent-memory/ (compact would otherwise
// rewrite a log.md outside the tree) and never get caught in a symlink cycle.
function walk(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) rec(p);
      else if (name.endsWith(".md")) out.push(p);
    }
  };
  rec(dir);
  return out;
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.venom-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path); // atomic on the same filesystem — no half-written log.md on crash/disk-full
}

export function scanMemory(memDir: string): MemFile[] {
  return walk(memDir)
    .map((abs) => {
      const rel = relative(memDir, abs).split("\\").join("/");
      const content = readFileSync(abs, "utf8");
      const category = categorize(rel);
      const entries = category === "log" || category === "archive" ? parseLog(content).entries.length : null;
      return { abs, rel, tok: estTokens(content), category, entries };
    })
    .sort((a, b) => b.tok - a.tok);
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

export function renderStats(memDir: string, budgets: Budgets): string {
  const files = scanMemory(memDir);
  const L: string[] = [];
  const total = files.reduce((s, f) => s + f.tok, 0);
  const hot = files.filter((f) => HOT_CATEGORIES.has(f.category)).reduce((s, f) => s + f.tok, 0);
  const cold = files.filter((f) => f.category === "archive").reduce((s, f) => s + f.tok, 0);

  const relDisp = relative(process.cwd(), memDir);
  const disp = !relDisp || relDisp.startsWith("..") ? memDir : relDisp;
  L.push("");
  L.push(bold(`  Shared memory — ${disp}`));
  L.push(dim(`  ${files.length} files · ~${fmt(total)} tok total   (~4 chars/token proxy)`));
  L.push("");
  L.push(`  ${bold("hot read-path")}  ~${fmt(hot)} tok   ${dim("(SNAPSHOT + distilled + logs + lessons — what agents read)")}`);
  L.push(`  ${dim("cold archives")}  ~${fmt(cold)} tok   ${dim("(compacted history — not read in the normal path)")}`);
  L.push("");

  const budgetFor = (f: MemFile): number | undefined => budgets.budgetsTok[basename(f.rel)] ?? budgets.budgetsTok[f.category];
  const over: string[] = [];
  L.push(bold("  Largest files"));
  for (const f of files.slice(0, 12)) {
    const b = budgetFor(f);
    const isOver = b != null && f.tok > b;
    const entryNote = f.entries != null ? dim(`  ${f.entries} entries`) : "";
    const flag = isOver ? yellow(`  ⚠ over ~${fmt(b!)} budget`) : "";
    L.push(`  ${dim("~" + fmt(f.tok).padStart(6))}  ${f.rel}${entryNote}${flag}`);
    if (isOver) over.push(f.rel);
  }
  L.push("");

  const logs = files.filter((f) => f.category === "log");
  const bloatedLogs = logs.filter((f) => (f.entries ?? 0) > budgets.hotLogEntries);
  if (bloatedLogs.length) {
    L.push(yellow(`  ${bloatedLogs.length} log(s) over ${budgets.hotLogEntries} entries — compact to bound the hot read-path:`));
    L.push(`    ${cyan("venom memory compact --write")}   ${dim("(archives old entries, never deletes)")}`);
  } else if (over.length) {
    L.push(dim(`  ${over.length} file(s) over budget — consider distilling into the team's knowledge file.`));
  } else {
    L.push(green("  ✓ within budget — memory is lean."));
  }
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

export interface CompactResult {
  rel: string;
  plan: CompactPlan;
}

export function findLogs(memDir: string): string[] {
  return walk(memDir).filter((p) => basename(p) === "log.md");
}

export function renderCompact(memDir: string, opts: { keep?: number; budgetTok?: number }, write: boolean, budgets: Budgets): string {
  const keep = opts.budgetTok != null ? undefined : opts.keep ?? budgets.hotLogEntries;
  const logs = findLogs(memDir);
  const L: string[] = [];
  L.push("");
  L.push(bold(`  Compact team logs${write ? "" : dim("  (dry run — nothing written; pass --write to apply)")}`));
  const target = opts.budgetTok != null ? `budget ~${fmt(opts.budgetTok)} tok/log` : `newest ${keep} entries/log`;
  L.push(dim(`  Keep ${target}; archive the rest to log.archive.md (verbatim, appended).`));
  L.push("");

  let totalMoved = 0;
  let totalFreed = 0;
  for (const logPath of logs) {
    const content = readFileSync(logPath, "utf8");
    const plan = planCompact(content, { keep, budgetTok: opts.budgetTok });
    const rel = relative(memDir, logPath).split("\\").join("/");
    if (plan.movedCount === 0) {
      L.push(`  ${dim("—")} ${rel}  ${dim(`${plan.total} entries · nothing to archive`)}`);
      continue;
    }
    totalMoved += plan.movedCount;
    totalFreed += plan.freedTok;
    L.push(`  ${green("→")} ${rel}  ${dim(`${plan.total} entries → keep ${plan.keptCount}, archive ${plan.movedCount} (~${fmt(plan.freedTok)} tok off the hot path)`)}`);
    if (write) {
      const team = basename(relative(memDir, join(logPath, "..")).split("\\").join("/")) || "team";
      const archivePath = join(logPath, "..", "log.archive.md");
      const existing = existsSync(archivePath) ? readFileSync(archivePath, "utf8") : archiveHeader(team);
      const sep = existing.endsWith("\n") ? "" : "\n";
      // Archive first, then truncate the log — both atomic. If the process dies between the two, the
      // moved entries are safe in the archive and still in the log (a recoverable duplicate on the
      // next run), never lost.
      writeFileAtomic(archivePath, existing + sep + plan.archivedEntries);
      writeFileAtomic(logPath, plan.remaining);
    }
  }
  L.push("");
  if (totalMoved === 0) {
    L.push(green("  ✓ all logs within budget — nothing to compact."));
  } else if (write) {
    L.push(green(`  ✓ archived ${totalMoved} entries · ~${fmt(totalFreed)} tok moved off the hot read-path.`));
  } else {
    L.push(dim(`  Would archive ${totalMoved} entries · ~${fmt(totalFreed)} tok. Re-run with `) + cyan("--write") + dim(" to apply."));
  }
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// index — regenerate INDEX.md's auto entry-catalog (managed block).
// ---------------------------------------------------------------------------

const CAT_BEGIN = "<!-- VENOM:BEGIN memory-catalog — generated by `venom memory index`; edits inside are overwritten -->";
const CAT_END = "<!-- VENOM:END memory-catalog -->";

export function buildCatalog(memDir: string): string {
  const logs = findLogs(memDir)
    .map((p) => ({ p, rel: relative(memDir, p).split("\\").join("/"), entries: parseLog(readFileSync(p, "utf8")).entries }))
    .filter((l) => l.entries.length > 0)
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const lines: string[] = [];
  lines.push(CAT_BEGIN);
  lines.push("## Log entry catalog (auto-generated)");
  lines.push("");
  lines.push("> Scan this instead of opening whole logs. Refresh with `venom memory index --write`.");
  lines.push("");
  if (logs.length === 0) {
    lines.push("_No log entries yet._");
  } else {
    for (const l of logs) {
      lines.push(`### ${l.rel} — ${l.entries.length} ${l.entries.length === 1 ? "entry" : "entries"}`);
      for (const e of l.entries) {
        const head = (e.split("\n")[0] ?? "").replace(/^###\s*/, "").trim();
        lines.push(`- ${head}`);
      }
      lines.push("");
    }
  }
  lines.push(CAT_END);
  return lines.join("\n");
}

function countOccurrences(s: string, sub: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = s.indexOf(sub, i);
    if (j === -1) break;
    n++;
    i = j + sub.length;
  }
  return n;
}

// Returns the new content, or null if the existing markers are malformed. Refusing (null) rather than
// splicing on mismatched/duplicated markers is what stops `index --write` from deleting hand-written
// content that got sandwiched between a stray marker and a real one.
function upsertManagedBlock(indexContent: string, block: string): string | null {
  const nBegin = countOccurrences(indexContent, CAT_BEGIN);
  const nEnd = countOccurrences(indexContent, CAT_END);
  if (nBegin === 0 && nEnd === 0) {
    const sep = indexContent.endsWith("\n") ? "\n" : "\n\n";
    return indexContent + sep + block + "\n";
  }
  if (nBegin === 1 && nEnd === 1) {
    const b = indexContent.indexOf(CAT_BEGIN);
    const e = indexContent.indexOf(CAT_END);
    if (e > b) return indexContent.slice(0, b) + block + indexContent.slice(e + CAT_END.length);
  }
  return null;
}

export function renderIndex(memDir: string, write: boolean): string {
  const block = buildCatalog(memDir);
  const indexPath = join(memDir, "INDEX.md");
  const L: string[] = [];
  L.push("");
  if (write) {
    const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "# INDEX — the map of the team's shared memory\n";
    const updated = upsertManagedBlock(existing, block);
    if (updated === null) {
      L.push(yellow("  ! INDEX.md has malformed `VENOM:BEGIN/END memory-catalog` markers — not writing (to avoid deleting hand-written content)."));
      L.push(dim("    Fix or remove the managed block by hand, then re-run `venom memory index --write`."));
    } else {
      writeFileAtomic(indexPath, updated);
      L.push(green(`  ✓ Updated ${relative(process.cwd(), indexPath) || "INDEX.md"} — entry catalog refreshed.`));
    }
  } else {
    L.push(bold("  Memory entry catalog") + dim("  (preview — pass --write to save into INDEX.md)"));
    L.push("");
    L.push(
      block
        .split("\n")
        .filter((l) => !l.startsWith("<!--"))
        .map((l) => "  " + l)
        .join("\n"),
    );
  }
  L.push("");
  return L.join("\n");
}
