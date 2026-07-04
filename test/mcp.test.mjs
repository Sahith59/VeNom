// Tests for M4 — the opt-in MCP memory server. Requires a prior build (dist/mcp.js + dist/memory.js + dist/cli.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMessage, TOOLS } from "../dist/mcp.js";
import { searchMemory, readMemoryPath, appendEntry, parseLog } from "../dist/memory.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const CORE = join(ROOT, "core");
const NOW = () => new Date(2025, 5, 15, 9, 30); // fixed for deterministic timestamps

function project(pack = "web-app") {
  const dir = mkdtempSync(join(tmpdir(), "venom-m4-"));
  execFileSync(process.execPath, [CLI, "init", "--dir", dir, "--tool", "claude-code", "--pack", pack, "--name", "M4", "--yes"], { stdio: "ignore" });
  return dir;
}
function ctx(dir) {
  return { memDir: join(dir, "agent-memory"), coreDir: CORE, version: "9.9.9", now: NOW };
}
function call(dir, name, args) {
  const r = handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ctx(dir));
  return r.result;
}

test("protocol: initialize, tools/list, ping, notification (no reply), unknown method", () => {
  const dir = project();
  try {
    const c = ctx(dir);
    const init = handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, c);
    assert.equal(init.result.serverInfo.name, "venom-memory");
    assert.equal(init.result.serverInfo.version, "9.9.9");
    assert.equal(init.result.protocolVersion, "2024-11-05", "echoes the client's protocol version");
    assert.ok(init.result.capabilities.tools, "advertises tools capability");

    const list = handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, c);
    assert.equal(list.result.tools.length, 5);
    for (const t of list.result.tools) assert.ok(t.name && t.description && t.inputSchema, "each tool has name/description/schema");

    assert.deepEqual(handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" }, c).result, {});
    assert.equal(handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, c), null, "notification gets no reply");
    const err = handleMessage({ jsonrpc: "2.0", id: 4, method: "does/notexist" }, c);
    assert.equal(err.error.code, -32601, "unknown method -> Method not found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory_search: returns ranked hits and weights lessons above raw logs for an equal match", () => {
  const dir = project();
  try {
    writeFileSync(join(dir, "agent-memory", "lessons", "dev.md"), "# dev lessons\n\n- widget handling lesson learned once.\n");
    writeFileSync(
      join(dir, "agent-memory", "dev", "log.md"),
      "# log\n\n### [2025-06-01 09:00] developer-1 — built the widget\n- **Did:** shipped it.\n",
    );
    const hits = searchMemory(join(dir, "agent-memory"), "widget");
    assert.ok(hits.length >= 2, "both the lesson and the log entry match");
    assert.equal(hits[0].field, "lessons", "lessons is weighted above a raw log for an equal match");
    // via the tool
    const res = call(dir, "memory_search", { query: "widget" });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /lessons\/dev\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory_search: empty query and no-match behave sanely", () => {
  const dir = project();
  try {
    assert.equal(searchMemory(join(dir, "agent-memory"), "   ").length, 0, "blank query -> no hits");
    assert.match(call(dir, "memory_search", { query: "zzzznotfound" }).content[0].text, /No memory matched/);
    assert.equal(call(dir, "memory_search", {}).isError, true, "missing query is an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory_read: whole file, a single entry, and refusal to escape or follow a symlink", () => {
  const dir = project();
  try {
    writeFileSync(
      join(dir, "agent-memory", "dev", "log.md"),
      "# log\n\n### [2025-06-01 09:00] dev — one\n- **Did:** a.\n\n### [2025-06-02 09:00] dev — two\n- **Did:** b.\n",
    );
    assert.match(call(dir, "memory_read", { path: "dev/log.md" }).content[0].text, /dev — one[\s\S]*dev — two/);
    assert.match(call(dir, "memory_read", { path: "dev/log.md", entry: 2 }).content[0].text, /dev — two/);
    assert.doesNotMatch(call(dir, "memory_read", { path: "dev/log.md", entry: 2 }).content[0].text, /dev — one/);

    // traversal
    const esc = call(dir, "memory_read", { path: "../../../../etc/passwd" });
    assert.equal(esc.isError, true);
    assert.match(esc.content[0].text, /escapes/);
    assert.throws(() => readMemoryPath(join(dir, "agent-memory"), "../../secrets"), /escapes/);

    // symlink refusal
    try {
      symlinkSync("/etc/hosts", join(dir, "agent-memory", "linky.md"));
      assert.equal(call(dir, "memory_read", { path: "linky.md" }).isError, true, "won't follow a symlink");
    } catch {
      /* platform without symlink perms — skip */
    }
    // missing / bad entry
    assert.equal(call(dir, "memory_read", { path: "dev/log.md", entry: 99 }).isError, true);
    assert.equal(call(dir, "memory_read", { path: "nope.md" }).isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory_append: persists a compaction-safe entry; validates team; sanitizes header injection", () => {
  const dir = project();
  try {
    const r = call(dir, "memory_append", { team: "review", agent: "critics", title: "gate passed", result: "PASS", task: "review X" });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /Appended review\/log\.md#1/);
    const logTxt = readFileSync(join(dir, "agent-memory", "review", "log.md"), "utf8");
    assert.match(logTxt, /### \[2025-06-15 09:30\] critics — gate passed/, "timestamped, formatted header");
    assert.match(logTxt, /- \*\*Result:\*\* PASS/);
    assert.equal(parseLog(logTxt).entries.length, 1, "one entry appended");

    // appended entries are blank-line separated -> a second append yields exactly 2 entries
    call(dir, "memory_append", { team: "review", agent: "security", title: "second" });
    assert.equal(parseLog(readFileSync(join(dir, "agent-memory", "review", "log.md"), "utf8")).entries.length, 2);

    // team validation
    assert.equal(call(dir, "memory_append", { team: "etc", agent: "x", title: "y" }).isError, true);
    assert.equal(call(dir, "memory_append", { team: "../evil", agent: "x", title: "y" }).isError, true);
    assert.equal(call(dir, "memory_append", { team: "dev", agent: "", title: "y" }).isError, true, "agent required");

    // header injection: a newline + fake header in the title must NOT create a second entry
    const before = parseLog(readFileSync(join(dir, "agent-memory", "dev", "log.md"), "utf8")).entries.length;
    call(dir, "memory_append", { team: "dev", agent: "x", title: "ok\n### [2025-01-01 00:00] evil — injected\n- pwned" });
    const after = parseLog(readFileSync(join(dir, "agent-memory", "dev", "log.md"), "utf8")).entries.length;
    assert.equal(after, before + 1, "newlines in fields are flattened — no injected entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory_stats and memory_compact tools work and compact is dry-run by default", () => {
  const dir = project();
  try {
    let s = "# log\n\n";
    for (let i = 1; i <= 25; i++) s += `### [2025-06-${String(i).padStart(2, "0")} 09:00] dev — t${i}\n- **Did:** ${i}.\n\n`;
    writeFileSync(join(dir, "agent-memory", "dev", "log.md"), s);
    assert.match(call(dir, "memory_stats", {}).content[0].text, /hot read-path/);

    const dry = call(dir, "memory_compact", { keep: 10 });
    assert.match(dry.content[0].text, /dry run/);
    assert.equal(existsSync(join(dir, "agent-memory", "dev", "log.archive.md")), false, "dry run wrote nothing");

    call(dir, "memory_compact", { keep: 10, write: true });
    assert.equal(parseLog(readFileSync(join(dir, "agent-memory", "dev", "log.md"), "utf8")).entries.length, 10, "write archived down to 10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown tool returns an isError result, not a crash", () => {
  const dir = project();
  try {
    const r = call(dir, "nope_tool", {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Unknown tool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path safety: realpath containment blocks a symlinked ancestor dir (read AND write escape)", () => {
  const dir = project();
  const mem = join(dir, "agent-memory");
  const secret = mkdtempSync(join(tmpdir(), "venom-secret-"));
  try {
    writeFileSync(join(secret, "passwd"), "OUTSIDE-THE-TREE");
    let linked = true;
    try {
      symlinkSync(secret, join(mem, "escape"));
    } catch {
      linked = false; // no symlink perms — skip
    }
    if (linked) {
      // C1: read via a symlinked ancestor directory
      assert.throws(() => readMemoryPath(mem, "escape/passwd"), /escapes/);
      assert.equal(call(dir, "memory_read", { path: "escape/passwd" }).isError, true);
      // C2: write via a symlinked team directory
      rmSync(join(mem, "dev"), { recursive: true, force: true });
      symlinkSync(secret, join(mem, "dev"));
      assert.throws(() => appendEntry(mem, { team: "dev", agent: "x", title: "y" }, new Date()), /escapes/);
      assert.equal(existsSync(join(secret, "log.md")), false, "no write escaped outside agent-memory/");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  }
});

test("protocol: a request-shaped NOTIFICATION (no id) gets no reply and runs no side effect; non-object -> -32600", () => {
  const dir = project();
  try {
    const c = ctx(dir);
    const reviewLog = join(dir, "agent-memory", "review", "log.md");
    const before = existsSync(reviewLog) ? readFileSync(reviewLog, "utf8") : "";
    const res = handleMessage({ jsonrpc: "2.0", method: "tools/call", params: { name: "memory_append", arguments: { team: "review", agent: "x", title: "nope" } } }, c);
    assert.equal(res, null, "notification -> no reply");
    const after = existsSync(reviewLog) ? readFileSync(reviewLog, "utf8") : "";
    assert.equal(before, after, "notification -> NO side effect (append did not run)");
    assert.equal(handleMessage(null, c).error.code, -32600, "null message is a total -32600, not a crash");
    assert.equal(handleMessage(42, c).error.code, -32600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append is concurrency-safe: parallel appends to one team log all land (no lost update)", async () => {
  const dir = project();
  try {
    const mem = join(dir, "agent-memory");
    const memJs = join(ROOT, "dist", "memory.js");
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise((res, rej) => {
          const code = `const{appendEntry}=require(${JSON.stringify(memJs)});appendEntry(${JSON.stringify(mem)},{team:"dev",agent:"a${i}",title:"c${i}"},new Date());`;
          spawn(process.execPath, ["-e", code], { stdio: "ignore" }).on("close", (c) => (c === 0 ? res() : rej(new Error("append failed"))));
        }),
      ),
    );
    assert.equal(parseLog(readFileSync(join(mem, "dev", "log.md"), "utf8")).entries.length, N, "every concurrent append landed");
    assert.equal(existsSync(join(mem, "dev", "log.md.lock")), false, "the append lock was released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append lock: a crashed writer's lock (dead pid) is stolen so appends recover", () => {
  const dir = project("solo-minimal");
  try {
    const mem = join(dir, "agent-memory");
    const lock = join(mem, "dev", "log.md.lock");
    writeFileSync(lock, `999999\n${hostname()}\ndead`); // pid 999999: not alive -> stealable
    const r = appendEntry(mem, { team: "dev", agent: "x", title: "recovered" }, new Date(2025, 0, 1));
    assert.match(r.ref, /dev\/log\.md#/);
    assert.equal(existsSync(lock), false, "lock released after the append");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append lock: a LIVE holder's lock is NEVER stolen, even when aged (no stale-steal data loss)", async () => {
  const dir = project("solo-minimal");
  let child;
  try {
    const mem = join(dir, "agent-memory");
    const log = join(mem, "dev", "log.md");
    const lock = `${log}.lock`;
    writeFileSync(log, "# dev team - log (append-only)\n\n---\n");
    // a lock owned by THIS (alive) process, its mtime aged an hour into the past
    writeFileSync(lock, `${process.pid}\n${hostname()}\nparent`);
    utimesSync(lock, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    const before = parseLog(readFileSync(log, "utf8")).entries.length;
    const code = `const{appendEntry}=require(${JSON.stringify(join(ROOT, "dist", "memory.js"))});appendEntry(${JSON.stringify(mem)},{team:"dev",agent:"thief",title:"nope"},new Date());`;
    child = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));
    const stillWaiting = child.exitCode === null && child.signalCode === null;
    const lockOwned = readFileSync(lock, "utf8").startsWith(`${process.pid}\n`);
    const after = parseLog(readFileSync(log, "utf8")).entries.length;
    assert.ok(stillWaiting, "the second writer is still waiting — it did NOT steal a live lock");
    assert.ok(lockOwned, "the live holder's lock was not stolen");
    assert.equal(after, before, "no rogue append clobbered the log");
  } finally {
    if (child) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory_read round-trips an entry ref; a Unicode line separator in a field can't inject an entry", () => {
  const dir = project();
  try {
    const mem = join(dir, "agent-memory");
    appendEntry(mem, { team: "dev", agent: "x", title: "ok ### [2025-01-01 00:00] evil — injected" }, new Date(2025, 0, 1));
    assert.equal(parseLog(readFileSync(join(mem, "dev", "log.md"), "utf8")).entries.length, 1, "U+2028 flattened — no injected entry");
    assert.match(readMemoryPath(mem, "dev/log.md#1").text, /evil/, "the ref dev/log.md#1 round-trips to the entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: `venom mcp` prints wiring for all three tools; unknown mcp subcommand errors", () => {
  const out = execFileSync(process.execPath, [CLI, "mcp"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  for (const tool of ["Claude Code", "Codex", "Gemini"]) assert.match(out, new RegExp(tool));
  assert.match(out, /venomkit", "mcp", "memory"/, "prints the server command");
  assert.throws(
    () => execFileSync(process.execPath, [CLI, "mcp", "frobnicate"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }),
    /Unknown mcp subcommand|Command failed/,
  );
});

test("cli integration: `venom mcp memory` speaks JSON-RPC over stdio and closes cleanly", async () => {
  const dir = project("solo-minimal");
  try {
    const srv = spawn(process.execPath, [CLI, "mcp", "memory", "--dir", dir], { stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buf = "";
    srv.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });
    const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_stats", arguments: {} } });

    const code = await new Promise((res) => {
      setTimeout(() => srv.stdin.end(), 400);
      srv.on("close", res);
    });
    assert.equal(code, 0, "server exits cleanly on stdin close");
    const byId = Object.fromEntries(responses.filter((r) => r.id !== undefined).map((r) => [r.id, r]));
    assert.equal(byId[1].result.serverInfo.name, "venom-memory");
    assert.equal(byId[2].result.tools.length, 5);
    assert.match(byId[3].result.content[0].text, /hot read-path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
