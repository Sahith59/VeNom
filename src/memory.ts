// `venom memory` — inspect, bound, and index the team's shared memory (`agent-memory/`).
//
// The honest boundary: Venom does not own the LLM call, so this cannot reduce tokens at inference.
// What it does is keep the on-disk memory the agents are asked to read *bounded and navigable*:
//   stats   — where the memory tokens actually are (hot read-path vs. cold archives).
//   compact — move old team-log entries out of the hot log into a verbatim archive (never deletes).
//   index   — regenerate INDEX.md's entry catalog so agents scan an index instead of whole logs.
// Compaction is byte-exact, archive-not-delete, dry-run by default, and idempotent.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  statSync,
  renameSync,
  mkdirSync,
  realpathSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { join, relative, basename, resolve, dirname, sep } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
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

let tmpCounter = 0;
function writeFileAtomic(path: string, content: string): void {
  // Unique temp name (pid + counter) so two writers on the same file never clobber each other's temp.
  const tmp = `${path}.${process.pid}.${++tmpCounter}.venom-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path); // atomic on the same filesystem — no half-written log.md on crash/disk-full
}

function sleepMs(ms: number): void {
  // zero-dep synchronous sleep (no busy-wait): block this thread on an untouched SharedArrayBuffer.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const HOST = hostname();
const HARD_STALE_MS = 120000; // last-resort steal when we CAN'T check liveness (cross-host lock)
const STEAL_STALE_MS = 10000; // a steal-token is held for microseconds; older than this ⇒ orphaned
let lockNonce = 0;
// A lock/token nonce must be unique across every contender on the same file. pid+counter already
// distinguishes separate processes on one host; the random suffix makes it unique even when pid is
// shared (e.g. worker threads) or across hosts, so ownership/release checks can never false-match.
function newNonce(): string {
  return `${process.pid}-${Date.now()}-${++lockNonce}-${randomBytes(6).toString("hex")}`;
}

interface LockOwner {
  pid: number;
  host: string;
  nonce: string;
}
function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const [pid, host, nonce] = readFileSync(lockPath, "utf8").split("\n");
    return { pid: Number(pid), host: host ?? "", nonce: nonce ?? "" };
  } catch {
    return null;
  }
}
// Same-host: ask the OS whether the holder pid is alive. Cross-host: we can't, so report alive.
function holderAlive(owner: LockOwner): boolean {
  if (owner.host !== HOST) return true;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM etc. -> exists (alive)
  }
}

// Recover an abandoned lock WITHOUT ever clobbering one that was re-acquired between our inspection and
// our removal (the steal-then-re-race TOCTOU). Recoverers are serialized behind a short-lived "steal
// token"; once we hold it we RE-CONFIRM the main lock is still abandoned before removing it. While the
// token is held and the (still-present) main lock blocks any openSync('wx'), no fresh lock can be
// installed — so the owner we re-read is exactly the one we remove, and a lock re-acquired in the
// meantime is seen as alive/fresh and left untouched. Returns true if we held the token and acted
// (caller may retry immediately); false if another recoverer holds it (caller should back off).
function recoverAbandonedLock(lockPath: string): boolean {
  const stealPath = `${lockPath}.steal`;
  const stealNonce = newNonce();
  let sfd: number;
  try {
    sfd = openSync(stealPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    // Someone else is recovering. Reclaim the token only if it's provably orphaned — mirroring the main
    // lock's own discipline: a SAME-HOST token is reclaimed ONLY when its holder pid is dead (never on
    // time, so a merely-slow live recoverer is never stolen from → two recoverers can't both hold the
    // token → the main-lock removal below can't race). Time is the fallback ONLY cross-host, where we
    // can't check liveness. Single-winner via rename so two can't both take it.
    const st = readLockOwner(stealPath);
    let stAge = Infinity;
    try {
      stAge = Date.now() - statSync(stealPath).mtimeMs;
    } catch {
      return false; // vanished — retry the main lock
    }
    const stDead = st !== null && st.host === HOST && !holderAlive(st);
    const stCrossStale = (st === null || st.host !== HOST) && stAge > STEAL_STALE_MS;
    if (stDead || stCrossStale) {
      try {
        const claim = `${stealPath}.${process.pid}.reclaim`;
        renameSync(stealPath, claim);
        unlinkSync(claim);
      } catch {
        /* another recoverer won the reclaim, or it vanished — fine */
      }
    }
    return false;
  }
  try {
    writeSync(sfd, `${process.pid}\n${HOST}\n${stealNonce}`);
    const owner = readLockOwner(lockPath);
    if (owner === null) return true; // already gone
    let ageMs = Infinity;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      return true; // vanished — nothing to remove
    }
    const deadCrash = owner.host === HOST && !holderAlive(owner);
    const crossHostStale = owner.host !== HOST && ageMs > HARD_STALE_MS;
    if (deadCrash || crossHostStale) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone — fine */
      }
    }
    // else: a fresh, live (or no-longer-stale) lock was installed after our first inspection — leave it.
    return true;
  } finally {
    try {
      closeSync(sfd);
    } catch {
      /* ignore */
    }
    try {
      const cur = readLockOwner(stealPath);
      if (cur === null || cur.nonce === stealNonce) unlinkSync(stealPath);
    } catch {
      /* ignore */
    }
  }
}

// Serialize a read-modify-write on `path` across processes with an exclusive lockfile so two agents
// appending (or a compact racing an append) can't lost-update each other.
//
// Stealing is owner-verified, not time-only: we steal a same-host lock ONLY when the holder pid is
// confirmed dead (a crash), so a live-but-slow / suspended / clock-skewed holder is NEVER stolen (it
// would silently clobber that holder's write). A cross-host lock we can't probe, so we fall back to a
// long HARD_STALE cap. Release only unlinks the lock if it's still ours (a stolen lock belongs to the
// successor now — removing it would cascade). Fail-closed: give up after ~15s with a "busy" error
// rather than risk a steal.
function withLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`;
  const nonce = newNonce();
  const content = `${process.pid}\n${HOST}\n${nonce}`;
  const deadline = Date.now() + 15000;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readLockOwner(lockPath);
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      const deadCrash = owner !== null && owner.host === HOST && !holderAlive(owner);
      const crossHostStale = (owner === null || owner.host !== HOST) && ageMs > HARD_STALE_MS;
      if (deadCrash || crossHostStale) {
        // Looks abandoned. Recover it safely (serialized + re-confirmed under a steal token) instead of a
        // blind rename that could clobber a lock re-acquired since we inspected it. If another recoverer
        // holds the token, back off and retry until the deadline.
        if (!recoverAbandonedLock(lockPath)) {
          if (Date.now() > deadline) throw new Error(`"${basename(path)}" is busy — another writer holds the lock (retry shortly)`);
          sleepMs(50);
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`"${basename(path)}" is busy — another writer holds the lock (retry shortly)`);
      sleepMs(50);
      continue;
    }
    // We created the lock. Write our identity; if the write fails (e.g. ENOSPC after the inode was
    // created), clean up the orphan and the fd rather than leaving an empty lockfile behind.
    try {
      writeSync(fd, content);
    } catch (werr) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      throw werr;
    }
    break;
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    // Only remove the lock if it is STILL ours — if we were stolen (should only happen cross-host),
    // the lock now belongs to the successor and removing it would let a third writer in.
    try {
      const cur = readLockOwner(lockPath);
      if (cur === null || cur.nonce === nonce) unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

function safeTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // don't cut a surrogate pair in half
  return s.slice(0, end);
}

const SCAN_MAX_BYTES = 2_000_000; // bound stats/search reads so one oversized file can't OOM the process

// Read at most SCAN_MAX_BYTES of a file (the prefix) so an accidentally-huge memory file can't exhaust
// memory during a stats/search sweep. Stats/search are advisory, so a bounded prefix is acceptable.
function readCappedUtf8(abs: string): string {
  if (statSync(abs).size <= SCAN_MAX_BYTES) return readFileSync(abs, "utf8");
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(SCAN_MAX_BYTES);
    const n = readSync(fd, buf, 0, SCAN_MAX_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function scanMemory(memDir: string): MemFile[] {
  const out: MemFile[] = [];
  for (const abs of walk(memDir)) {
    let content: string;
    try {
      content = readCappedUtf8(abs);
    } catch {
      continue; // unreadable/removed — don't let one file break stats or search
    }
    const rel = relative(memDir, abs).split("\\").join("/");
    const category = categorize(rel);
    const entries = category === "log" || category === "archive" ? parseLog(content).entries.length : null;
    out.push({ abs, rel, tok: estTokens(content), category, entries });
  }
  return out.sort((a, b) => b.tok - a.tok);
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
    const rel = relative(memDir, logPath).split("\\").join("/");
    const doWrite = (): CompactPlan => {
      let content: string;
      try {
        content = readFileSync(logPath, "utf8");
      } catch {
        return { total: 0, keptCount: 0, movedCount: 0, freedTok: 0, remaining: "", archivedEntries: "" };
      }
      const p = planCompact(content, { keep, budgetTok: opts.budgetTok });
      if (write && p.movedCount > 0) {
        const team = basename(relative(memDir, join(logPath, "..")).split("\\").join("/")) || "team";
        const archivePath = join(logPath, "..", "log.archive.md");
        const existing = existsSync(archivePath) ? readFileSync(archivePath, "utf8") : archiveHeader(team);
        // The batch starts with a `### ` header, which parseLog only treats as an entry boundary when a
        // BLANK line precedes it. Guarantee the archive ends with "\n\n" so the appended batch's first
        // header isn't glued onto the previously-archived entry (would merge two entries; e.g. keep=0).
        const gap = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
        // Archive first, then truncate the log — both atomic. If the process dies between the two, the
        // moved entries are safe in the archive and still in the log (a recoverable duplicate on the
        // next run), never lost.
        writeFileAtomic(archivePath, existing + gap + p.archivedEntries);
        writeFileAtomic(logPath, p.remaining);
      }
      return p;
    };
    // When writing, hold the per-log lock across the re-read + plan + write so a concurrent append is
    // not lost; a dry run only reads, so it needs no lock.
    const plan = write ? withLock(logPath, doWrite) : doWrite();
    if (plan.movedCount === 0) {
      L.push(`  ${dim("—")} ${rel}  ${dim(`${plan.total} entries · nothing to archive`)}`);
      continue;
    }
    totalMoved += plan.movedCount;
    totalFreed += plan.freedTok;
    L.push(`  ${green("→")} ${rel}  ${dim(`${plan.total} entries → keep ${plan.keptCount}, archive ${plan.movedCount} (~${fmt(plan.freedTok)} tok off the hot path)`)}`);
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
    .map((p) => {
      let entries: string[] = [];
      try {
        entries = parseLog(readFileSync(p, "utf8")).entries;
      } catch {
        /* unreadable log — skip it rather than fail the whole index */
      }
      return { p, rel: relative(memDir, p).split("\\").join("/"), entries };
    })
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
    // Hold the lock across the read + splice + write so a concurrent `index --write` (or a human edit)
    // can't last-writer-wins clobber INDEX.md — same discipline as append/compact.
    const status = withLock(indexPath, (): "malformed" | "ok" => {
      const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "# INDEX — the map of the team's shared memory\n";
      const updated = upsertManagedBlock(existing, block);
      if (updated === null) return "malformed";
      writeFileAtomic(indexPath, updated);
      return "ok";
    });
    if (status === "malformed") {
      L.push(yellow("  ! INDEX.md has malformed `VENOM:BEGIN/END memory-catalog` markers — not writing (to avoid deleting hand-written content)."));
      L.push(dim("    Fix or remove the managed block by hand, then re-run `venom memory index --write`."));
    } else {
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

// ---------------------------------------------------------------------------
// Retrieval / read / append — the operations the opt-in MCP server exposes so an
// agent can fetch the right memory slice (or write one) with a tool call at inference,
// instead of reading whole files. Lexical (keyword) retrieval with field weighting —
// honest about being keyword-based, not embeddings.
// ---------------------------------------------------------------------------

const FIELD_WEIGHT: Record<string, number> = {
  snapshot: 5,
  lessons: 4,
  distilled: 4,
  decisions: 3,
  adr: 3,
  index: 2,
  log: 2,
  archive: 1,
  readme: 0,
  other: 1,
};

const KNOWN_TEAMS = ["dev", "research", "review", "security"];
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface SearchHit {
  ref: string;
  field: string;
  score: number;
  snippet: string;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function makeSnippet(text: string, qset: Set<string>): string {
  const lines = text.split("\n").map((l) => l.trim());
  const head = lines[0] ?? "";
  const hit = lines.find((l) => tokenize(l).some((t) => qset.has(t))) ?? "";
  const s = hit && hit !== head ? `${head} … ${hit}` : head || hit;
  return s.length > 240 ? safeTruncate(s, 237) + "…" : s;
}

function chunksOf(rel: string, category: string, content: string): Array<{ ref: string; text: string }> {
  if (category === "log" || category === "archive") {
    return parseLog(content).entries.map((e, i) => ({ ref: `${rel}#${i + 1}`, text: e }));
  }
  if (content.length > 1200) {
    const parts = content.split(/(?=^#{1,4} )/m).filter((p) => p.trim());
    if (parts.length > 1) return parts.map((p, i) => ({ ref: `${rel}#s${i + 1}`, text: p }));
  }
  return [{ ref: rel, text: content }];
}

export function searchMemory(memDir: string, query: string, opts: { limit?: number; includeArchived?: boolean } = {}): SearchHit[] {
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(50, Math.floor(opts.limit as number))) : 8;
  const qTerms = Array.from(new Set(tokenize(query)));
  if (qTerms.length === 0) return [];
  const qset = new Set(qTerms);
  const hits: SearchHit[] = [];
  // Walk + read lazily here (not via scanMemory) so we skip archives entirely when not requested and
  // never read cold storage we won't use; a single unreadable file is skipped, not fatal.
  for (const abs of walk(memDir)) {
    const rel = relative(memDir, abs).split("\\").join("/");
    const category = categorize(rel);
    if (category === "readme") continue; // the protocol doc, not project memory
    if (category === "archive" && !opts.includeArchived) continue;
    let content: string;
    try {
      content = readCappedUtf8(abs);
    } catch {
      continue; // unreadable/removed mid-scan — skip, don't fail the whole search
    }
    for (const ch of chunksOf(rel, category, content)) {
      const toks = tokenize(ch.text);
      if (toks.length === 0) continue;
      const counts = new Map<string, number>();
      for (const t of toks) if (qset.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
      if (counts.size === 0) continue;
      let occ = 0;
      for (const c of counts.values()) occ += c;
      const score = counts.size * 10 + occ + (FIELD_WEIGHT[category] ?? 1);
      hits.push({ ref: ch.ref, field: category, score, snippet: makeSnippet(ch.text, qset) });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  return hits.slice(0, limit);
}

// True only if `abs` really resolves inside memDir — realpath-based, so a symlinked ANCESTOR directory
// (e.g. agent-memory/dev -> /) cannot smuggle the target outside the tree. For a not-yet-existing
// target (a new log to create), we realpath its nearest existing ancestor.
function realWithin(memDir: string, abs: string): boolean {
  let realMem: string;
  try {
    realMem = realpathSync(resolve(memDir));
  } catch {
    return false;
  }
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    return false;
  }
  return real === realMem || real.startsWith(realMem + sep);
}

// Resolve a caller-supplied path safely inside memDir (no traversal, no symlink escape).
function safeResolve(memDir: string, relPath: string): string {
  const abs = resolve(memDir, relPath.replace(/^[/\\]+/, ""));
  const norm = resolve(memDir);
  if ((abs !== norm && !abs.startsWith(norm + sep)) || !realWithin(memDir, abs)) throw new Error("path escapes agent-memory/");
  return abs;
}

export interface ReadResult {
  ref: string;
  text: string;
  entries?: number;
}

export function readMemoryPath(memDir: string, relPath: string, entry?: number): ReadResult {
  if (typeof relPath !== "string" || !relPath.trim()) throw new Error("path is required");
  // Accept a search-style ref fragment so results round-trip: "dev/log.md#3" (entry) or "notes.md#s2" (section).
  let cleanPath = relPath;
  let frag: { section: boolean; n: number } | undefined;
  const m = relPath.match(/#(s?)(\d+)$/);
  if (m) {
    cleanPath = relPath.slice(0, m.index);
    frag = { section: m[1] === "s", n: Number(m[2]) };
  }
  if (entry != null) {
    if (!Number.isInteger(entry) || entry < 1) throw new Error("entry must be a positive integer");
    frag = { section: false, n: entry };
  }
  const abs = safeResolve(memDir, cleanPath);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`not found: ${cleanPath}`);
  }
  if (!st.isFile()) throw new Error(`not a file: ${cleanPath}`);
  const rel = relative(memDir, abs).split("\\").join("/");
  const MAX_READ = 2_000_000;
  let content: string;
  if (st.size > MAX_READ) {
    const fd = openSync(abs, "r");
    try {
      const buf = Buffer.alloc(MAX_READ);
      const n = readSync(fd, buf, 0, MAX_READ, 0);
      content = buf.subarray(0, n).toString("utf8") + `\n…[${rel} is ${st.size} bytes — showing the first ${MAX_READ}; narrow with memory_search or an entry number]`;
    } finally {
      closeSync(fd);
    }
  } else {
    content = readFileSync(abs, "utf8");
  }
  if (frag && !frag.section) {
    const entries = parseLog(content).entries;
    const e = entries[frag.n - 1];
    if (!e) throw new Error(`entry ${frag.n} not found — ${rel} has ${entries.length} entries`);
    return { ref: `${rel}#${frag.n}`, text: e, entries: entries.length };
  }
  if (frag && frag.section) {
    const secs = content.split(/(?=^#{1,4} )/m).filter((p) => p.trim());
    const s = secs[frag.n - 1];
    if (!s) throw new Error(`section ${frag.n} not found — ${rel} has ${secs.length} sections`);
    return { ref: `${rel}#s${frag.n}`, text: s };
  }
  return { ref: rel, text: content };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface AppendInput {
  team: string;
  agent: string;
  title: string;
  task?: string;
  did?: string;
  result?: string;
  refs?: string;
  next?: string;
}

// Append a correctly-formatted, blank-line-separated entry (so compaction/indexing find it).
export function appendEntry(memDir: string, e: AppendInput, now: Date): { ref: string; header: string } {
  if (!SAFE_SLUG.test(e.team) || !KNOWN_TEAMS.includes(e.team)) throw new Error(`unknown team "${e.team}" — use one of: ${KNOWN_TEAMS.join(", ")}`);
  const clean = (v: string | undefined): string => (v ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  const agent = clean(e.agent);
  const title = clean(e.title);
  if (!agent) throw new Error("agent is required");
  if (!title) throw new Error("title is required");
  const ts = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const lines = [`### [${ts}] ${agent} — ${title}`];
  const field = (label: string, v?: string): void => {
    const c = clean(v);
    if (c) lines.push(`- **${label}:** ${c}`);
  };
  field("Task", e.task);
  field("Did", e.did);
  field("Result", e.result);
  field("Refs", e.refs);
  field("Next / who needs to know", e.next);
  const entryText = lines.join("\n") + "\n";

  const teamDir = safeResolve(memDir, e.team);
  if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
  const logPath = join(teamDir, "log.md");
  // Hold an exclusive lock across the whole read-modify-write so two agents appending to the same
  // team log cannot lost-update each other (the shared file is the only channel between agents).
  const count = withLock(logPath, () => {
    const base = existsSync(logPath) ? readFileSync(logPath, "utf8") : `# ${e.team} team — log (append-only)\n\n---\n`;
    const existing = base.replace(/\n*$/, "\n\n"); // guarantee blank-line separation before the new entry
    const full = existing + entryText;
    writeFileAtomic(logPath, full);
    return parseLog(full).entries.length;
  });
  return { ref: `${e.team}/log.md#${count}`, header: lines[0]! };
}
