// Tests for M3 — `venom memory` (stats/compact/index). Requires a prior build (dist/memory.js + dist/cli.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLog, planCompact, buildCatalog } from "../dist/memory.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

const PREAMBLE = "# Dev team — log (append-only)\n\n> intro line.\n\n---\n";
function mkLog(n, preamble = PREAMBLE) {
  let s = preamble;
  for (let i = 1; i <= n; i++) {
    s +=
      `\n### [2025-02-${String(i).padStart(2, "0")} 09:00] developer-1 — task ${i}\n` +
      `- **Task:** do ${i}.\n- **Did:** did ${i}.\n- **Result:** ok ${i}.\n- **Refs:** src/x${i}.ts.\n- **Next / who needs to know:** testing.\n`;
  }
  return s;
}

test("parseLog: byte-exact split (preamble + entries === content) and correct entry count", () => {
  const content = mkLog(7);
  const { preamble, entries } = parseLog(content);
  assert.equal(entries.length, 7);
  assert.equal(preamble + entries.join(""), content, "reconstruction must be byte-identical");
  assert.ok(preamble.includes("append-only"), "preamble kept");
  assert.ok(entries[0].startsWith("### [2025-02-01"), "first entry starts at its header");
});

test("parseLog: a `###` header inside an HTML comment is NOT an entry (template example)", () => {
  const commented =
    "# Dev — log\n\n<!-- Example (delete me):\n### [2025-01-15 14:30] developer-1 — example\n- **Task:** x.\n-->\n";
  assert.equal(parseLog(commented).entries.length, 0, "commented example must not count");
  const mixed = commented + mkLog(3, "");
  assert.equal(parseLog(mixed).entries.length, 3, "only real entries count");
});

test("parseLog: no entries -> whole content is preamble", () => {
  const p = parseLog("# just a header\n\nno entries here\n");
  assert.equal(p.entries.length, 0);
  assert.equal(p.preamble, "# just a header\n\nno entries here\n");
});

test("parseLog: quoting a REAL header at column 0 in a body does not tear the entry (Finding 1)", () => {
  // The memory protocol tells agents to cite entries they build on — so a real `### [..]` header can
  // legitimately appear inside another entry's body. It must NOT become its own entry.
  const c =
    "# log\n\n---\n\n" +
    "### [2025-03-01 10:00] boss-1 — retro on the outage\n" +
    "- **Did:** reconstructed the timeline. The triggering entry was:\n" +
    "### [2025-02-15 03:00] oncall — db failover started\n" +
    "- **Result:** root-caused; owner notified.\n";
  const p = parseLog(c);
  assert.equal(p.entries.length, 1, "one logical entry — the cited header is body, not a new entry");
  assert.equal(p.preamble + p.entries.join(""), c, "byte-exact");
  assert.equal(planCompact(c, { keep: 1 }).movedCount, 0, "single entry: nothing torn into the archive");
});

test("parseLog: recognizes seconds and single-digit-hour timestamps agents write (Finding 2)", () => {
  const c =
    "# log\n\n" +
    "### [2025-02-01 09:00:07] dev — one\n- **Did:** a.\n\n" +
    "### [2025-02-02 9:30] dev — two\n- **Did:** b.\n\n" +
    "### [2025-02-03 09:00:15] dev — three\n- **Did:** c.\n";
  assert.equal(parseLog(c).entries.length, 3, "seconds and single-digit hours are still entries");
});

test("parseLog: placeholder / fenced / mid-body headers are not entries; entries around fences are found", () => {
  // placeholder header quoted in a body (blank-separated 3rd entry) — the placeholder is not a 4th entry
  const withPlaceholder =
    mkLog(2, "# log\n\n") +
    "\n### [2025-02-03 09:00] developer-1 — real\n- **Did:** quotes `### [YYYY-MM-DD HH:MM] agent — title`.\n";
  assert.equal(parseLog(withPlaceholder).entries.length, 3, "placeholder is not an entry");

  // a header inside a ``` fence (not blank-separated) must not split its entry
  const fenced =
    "# log\n\n### [2025-02-01 09:00] dev — one\n- **Did:** example:\n```\n### [2025-02-02 09:00] dev — in fence\n```\n- **Result:** ok.\n";
  assert.equal(parseLog(fenced).entries.length, 1, "fenced header does not tear the entry");

  // but two real, blank-separated entries around a fenced block are both found (Finding 4)
  const two =
    "# log\n\n### [2025-01-01 09:00] dev — one\n- **Did:** see:\n```\ncode\n```\n\n### [2025-01-02 09:00] dev — two\n- **Did:** real.\n";
  assert.equal(parseLog(two).entries.length, 2, "fenced code in entry one doesn't hide entry two");
});

test("parseLog: a stray `<!--` mid-body does not swallow later entries", () => {
  const content =
    "# log\n\n" +
    "### [2025-02-01 09:00] dev — a\n- **Did:** wrote a <!-- token inline.\n\n" +
    "### [2025-02-02 09:00] dev — b\n- **Did:** normal.\n\n" +
    "### [2025-02-03 09:00] dev — c\n- **Result:** closes --> here.\n";
  assert.equal(parseLog(content).entries.length, 3, "line-anchored comments only; no entry swallowed");
});

test("planCompact: keep newest N, archive rest, byte-exact round-trip (no entry lost or altered)", () => {
  const content = mkLog(25);
  const orig = parseLog(content).entries;
  const plan = planCompact(content, { keep: 20 });
  assert.equal(plan.total, 25);
  assert.equal(plan.keptCount, 20);
  assert.equal(plan.movedCount, 5);
  const moved = parseLog(plan.archivedEntries).entries; // archivedEntries has no preamble
  const kept = parseLog(plan.remaining).entries;
  assert.equal(moved.length, 5);
  assert.equal(kept.length, 20);
  assert.deepEqual([...moved, ...kept], orig, "archived(oldest)+kept(newest) must equal the original entries, in order");
  assert.equal(kept[0], orig[5], "kept starts at the 6th (index 5) entry");
  assert.ok(plan.remaining.startsWith(PREAMBLE), "preamble preserved in the live log");
});

test("planCompact: no-op when entries <= keep", () => {
  const content = mkLog(10);
  const plan = planCompact(content, { keep: 20 });
  assert.equal(plan.movedCount, 0);
  assert.equal(plan.archivedEntries, "");
  assert.equal(plan.remaining, content, "content untouched");
});

test("planCompact: idempotent — compacting the remaining is a no-op", () => {
  const content = mkLog(25);
  const first = planCompact(content, { keep: 20 });
  const second = planCompact(first.remaining, { keep: 20 });
  assert.equal(second.movedCount, 0);
  assert.equal(second.remaining, first.remaining);
});

test("planCompact: budget mode keeps newest entries under the token budget (>=1)", () => {
  const content = mkLog(25);
  const perEntry = parseLog(content).entries.map((e) => Math.ceil(e.length / 4))[0];
  const plan = planCompact(content, { budgetTok: perEntry * 3 + 1 });
  assert.ok(plan.keptCount >= 1 && plan.keptCount <= 4, `kept ~3 under budget, got ${plan.keptCount}`);
  // even a tiny budget keeps at least the newest one
  assert.equal(planCompact(content, { budgetTok: 1 }).keptCount, 1);
});

test("buildCatalog: lists each log's entry headers; empty logs omitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3cat-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "web-app", "--name", "Cat", "--yes"]);
    writeFileSync(join(dir, "agent-memory", "dev", "log.md"), mkLog(3));
    const cat = buildCatalog(join(dir, "agent-memory"));
    assert.match(cat, /dev\/log\.md — 3 entries/);
    assert.match(cat, /developer-1 — task 1/);
    assert.doesNotMatch(cat, /review\/log\.md/, "empty review log omitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli e2e: compact dry-run does NOT mutate; --write archives; second run is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "web-app", "--name", "M3", "--yes"]);
    const logPath = join(dir, "agent-memory", "dev", "log.md");
    const archivePath = join(dir, "agent-memory", "dev", "log.archive.md");
    const seeded = mkLog(25);
    writeFileSync(logPath, seeded);

    // dry run
    const dry = run(["memory", "compact", "--dir", dir, "--keep", "10"]);
    assert.match(dry, /dry run/);
    assert.equal(readFileSync(logPath, "utf8"), seeded, "dry run must not touch the log");
    assert.equal(existsSync(archivePath), false, "dry run must not create an archive");

    // write
    run(["memory", "compact", "--dir", dir, "--keep", "10", "--write"]);
    const keptEntries = parseLog(readFileSync(logPath, "utf8")).entries;
    const archEntries = parseLog(readFileSync(archivePath, "utf8")).entries;
    assert.equal(keptEntries.length, 10);
    assert.equal(archEntries.length, 15);
    assert.deepEqual([...archEntries, ...keptEntries], parseLog(seeded).entries, "no entry lost across the real write");

    // idempotent
    run(["memory", "compact", "--dir", dir, "--keep", "10", "--write"]);
    assert.equal(parseLog(readFileSync(logPath, "utf8")).entries.length, 10, "second compact is a no-op");
    assert.equal(parseLog(readFileSync(archivePath, "utf8")).entries.length, 15, "archive unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli e2e: a second batch of entries archives in chronological order (never deletes)", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3seq-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "web-app", "--name", "Seq", "--yes"]);
    const logPath = join(dir, "agent-memory", "dev", "log.md");
    const archivePath = join(dir, "agent-memory", "dev", "log.archive.md");

    writeFileSync(logPath, mkLog(15));
    run(["memory", "compact", "--dir", dir, "--keep", "10", "--write"]); // archive 5 (tasks 1..5)
    const firstArch = parseLog(readFileSync(archivePath, "utf8")).entries;
    assert.equal(firstArch.length, 5);

    // append 10 more real entries (tasks 16..25), blank-line-separated as the format requires
    const more = parseLog(mkLog(25)).entries.slice(15).join("");
    writeFileSync(logPath, readFileSync(logPath, "utf8").replace(/\n*$/, "\n\n") + more);
    run(["memory", "compact", "--dir", dir, "--keep", "10", "--write"]);

    // first pass archived tasks 1-5; second pass keeps newest 10 (16-25) and archives 6-15.
    const arch = parseLog(readFileSync(archivePath, "utf8")).entries;
    assert.equal(arch.length, 15, "archive accumulated (5 + 10), nothing deleted");
    assert.match(arch[0], /task 1\b/, "oldest archived first");
    assert.match(arch[arch.length - 1], /task 15\b/, "chronological order preserved");
    assert.equal(parseLog(readFileSync(logPath, "utf8")).entries.length, 10, "live log holds newest 10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli e2e: index --write is idempotent and preserves the human map", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3idx-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "web-app", "--name", "Idx", "--yes"]);
    const idxPath = join(dir, "agent-memory", "INDEX.md");
    writeFileSync(join(dir, "agent-memory", "dev", "log.md"), mkLog(4));
    run(["memory", "index", "--dir", dir, "--write"]);
    const once = readFileSync(idxPath, "utf8");
    assert.match(once, /VENOM:BEGIN memory-catalog/);
    assert.match(once, /dev\/log\.md — 4 entries/);
    assert.match(once, /Read-first files/, "human-written map preserved");
    run(["memory", "index", "--dir", dir, "--write"]);
    assert.equal(readFileSync(idxPath, "utf8"), once, "re-running index produces an identical file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli e2e: index refuses to write (preserving content) when markers are malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3bad-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "web-app", "--name", "Bad", "--yes"]);
    const idxPath = join(dir, "agent-memory", "INDEX.md");
    // a BEGIN marker with no matching END, and hand-written content after it
    const human =
      "# INDEX\n<!-- VENOM:BEGIN memory-catalog — generated by `venom memory index`; edits inside are overwritten -->\n## Hand-written IMPORTANT map\nkeep me\n";
    writeFileSync(idxPath, human);
    writeFileSync(join(dir, "agent-memory", "dev", "log.md"), mkLog(2));
    const out = run(["memory", "index", "--dir", dir, "--write"]);
    assert.match(out, /malformed/i, "warns instead of clobbering");
    const after = readFileSync(idxPath, "utf8");
    assert.match(after, /Hand-written IMPORTANT map/, "human content NOT deleted");
    assert.match(after, /keep me/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: --keep=N and --dir=PATH (equals form) are honored, not silently defaulted (Finding 3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3eq-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "solo-minimal", "--name", "Eq", "--yes"]);
    writeFileSync(join(dir, "agent-memory", "dev", "log.md"), mkLog(30));
    const out = run(["memory", "compact", `--dir=${dir}`, "--keep=5"]);
    assert.match(out, /newest 5 entries/, "equals-form --keep=5 honored (not defaulted to 20)");
    assert.match(out, /dev\/log\.md/, "equals-form --dir targeted the right project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: compact rejects --keep with no/empty/dashed value (never silently archives everything)", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3kv-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "solo-minimal", "--name", "KV", "--yes"]);
    for (const bad of ["-5", "="]) {
      const args = bad === "=" ? ["memory", "compact", "--dir", dir, "--keep="] : ["memory", "compact", "--dir", dir, "--keep", bad];
      try {
        run(args);
        assert.fail(`should reject --keep ${bad}`);
      } catch (e) {
        assert.match(String(e.stderr || e.message), /numeric value/, `--keep ${bad} rejected`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli e2e: compact never follows a symlink out of agent-memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3sym-"));
  const outside = mkdtempSync(join(tmpdir(), "venom-outside-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "solo-minimal", "--name", "Sym", "--yes"]);
    const outLog = join(outside, "log.md");
    writeFileSync(outLog, mkLog(5));
    const before = readFileSync(outLog, "utf8");
    try {
      symlinkSync(outside, join(dir, "agent-memory", "linked"));
    } catch {
      return; // platform without symlink permission — skip
    }
    run(["memory", "compact", "--dir", dir, "--keep", "1", "--write"]);
    assert.equal(readFileSync(outLog, "utf8"), before, "a log.md outside agent-memory must be untouched");
    assert.equal(existsSync(join(outside, "log.archive.md")), false, "no archive created outside the tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cli e2e: stats reports hot vs cold and flags over-budget logs; missing dir errors cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-m3stat-"));
  try {
    run(["init", "--dir", dir, "--tool", "claude-code", "--pack", "web-app", "--name", "Stat", "--yes"]);
    writeFileSync(join(dir, "agent-memory", "dev", "log.md"), mkLog(30));
    const out = run(["memory", "stats", "--dir", dir]);
    assert.match(out, /hot read-path/);
    assert.match(out, /cold archives/);
    assert.match(out, /over 20 entries/, "flags the bloated log");

    // missing agent-memory errors with a nonzero exit and a helpful message
    const empty = mkdtempSync(join(tmpdir(), "venom-m3none-"));
    try {
      run(["memory", "stats", "--dir", empty]);
      assert.fail("should have exited nonzero");
    } catch (e) {
      assert.match(String(e.stderr || e.stdout || e.message), /No agent-memory/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
