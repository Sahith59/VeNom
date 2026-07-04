// Tests for the MCP agent router — list_agents / agent_brief / route / handoff.
// The router reads the ACTUAL installed roster (so a custom --roles team routes correctly), matches
// tasks to agents by honest keyword scoring, and handoff logs the delegation to shared memory.
// Requires a prior build (dist/router.js + dist/mcp.js + dist/cli.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMessage } from "../dist/mcp.js";
import { loadRoster, agentBrief, routeTask, logTeamForRole } from "../dist/router.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const CORE = join(ROOT, "core");
const NOW = () => new Date(2025, 5, 15, 9, 30);

function project(extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), "venom-router-"));
  execFileSync(process.execPath, [CLI, "init", "--dir", dir, "--tool", "claude-code", "--name", "R", "--yes", ...extraArgs], { stdio: "ignore" });
  return dir;
}
function ctx(dir) {
  return { memDir: join(dir, "agent-memory"), coreDir: CORE, projectDir: dir, version: "9.9.9", now: NOW };
}
function call(dir, name, args = {}) {
  const r = handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ctx(dir));
  return r.result;
}

test("loadRoster reads the ACTUAL installed roster, not a fixed pack", () => {
  const full = project(); // web-app default = 14
  const custom = project(["--roles", "developer-1,testing"]); // core 4 + 2
  try {
    const a = loadRoster(CORE, full).roles.map((r) => r.role);
    const b = loadRoster(CORE, custom).roles.map((r) => r.role);
    assert.ok(a.length > b.length, "the custom roster is smaller than the full pack");
    assert.deepEqual([...b].sort(), ["boss-1", "boss-2", "critics", "developer-1", "security", "testing"], "exactly the core gates + the two picks");
    assert.ok(!b.includes("design"), "a role the user didn't pick is NOT in the roster");
    assert.equal(loadRoster(CORE, full).roles[0].role, "boss-1", "boss-1 leads the list");
  } finally {
    rmSync(full, { recursive: true, force: true });
    rmSync(custom, { recursive: true, force: true });
  }
});

test("loadRoster errors clearly when there's no install record", () => {
  const dir = mkdtempSync(join(tmpdir(), "venom-noinstall-"));
  try {
    assert.throws(() => loadRoster(CORE, dir), /No Venom install/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRoster degrades cleanly on a corrupted install.json (null / non-object / dup roles)", () => {
  const dir = project();
  const rec = join(dir, ".venom", "install.json");
  try {
    writeFileSync(rec, "null");
    assert.throws(() => loadRoster(CORE, dir), /not a valid install record/, "a null record is rejected, not a TypeError");
    writeFileSync(rec, "12345");
    assert.throws(() => loadRoster(CORE, dir), /not a valid install record/, "a bare number is rejected");
    writeFileSync(rec, "{ not json");
    assert.throws(() => loadRoster(CORE, dir), /invalid JSON/, "unparseable is rejected");
    // duplicate roles collapse to one
    writeFileSync(rec, JSON.stringify({ tool: "claude-code", pack: "web-app", roles: ["boss-1", "developer-1", "developer-1", "developer-1"] }));
    const roles = loadRoster(CORE, dir).roles.map((r) => r.role);
    assert.deepEqual(roles, ["boss-1", "developer-1"], "a tampered file can't list a role twice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("route bounds work on a pathological task — no hang, no regex-too-large throw", () => {
  const dir = project();
  try {
    // ~700 KB of distinct tokens brought route to ~56s before the term cap; and a single multi-MB token
    // used to throw "regex too large". Both must now return promptly and cleanly.
    const manyTerms = Array.from({ length: 40000 }, (_, i) => `tok${i}`).join(" ");
    const start = Date.now();
    // real keywords FIRST (they must survive the clip/cap), then the blob
    const r1 = routeTask(CORE, dir, "test the payments module " + manyTerms);
    assert.ok(Date.now() - start < 3000, "a huge task completes quickly (term cap bounds the work)");
    assert.ok(r1.terms.length <= 160, "the term list is capped");
    assert.ok(r1.candidates.some((c) => c.role === "testing"), "real keywords near the front still route");

    // a single multi-MB token used to throw "regex too large"; it must be skipped, real words still match
    const r2 = routeTask(CORE, dir, "audit the auth for injection " + "z".repeat(2_000_000));
    assert.ok(r2.candidates.some((c) => c.role === "security"), "a giant token is skipped; the real words still match");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list_agents lists installed roles with one-liners and points to the other tools", () => {
  const dir = project(["--roles", "developer-1,testing"]);
  try {
    const res = call(dir, "list_agents");
    assert.ok(!res.isError, "not an error");
    const text = res.content[0].text;
    assert.match(text, /Installed agents \(6\)/, "counts the installed roster");
    assert.match(text, /developer-1/, "lists a specialist");
    assert.match(text, /boss-1/, "lists the orchestrator");
    assert.ok(!/\bdesign\b/.test(text), "does NOT list an agent the user didn't install");
    assert.match(text, /agent_brief\(role\)/, "points to agent_brief");
    assert.match(text, /route\(task\)/, "points to route");
    assert.match(text, /handoff\(role, task\)/, "points to handoff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent_brief returns the full spec, and flags a role that isn't installed", () => {
  const dir = project(["--roles", "developer-1,testing"]);
  try {
    const b = agentBrief(CORE, dir, "developer-1");
    assert.equal(b.role, "developer-1");
    assert.equal(b.installed, true);
    assert.ok(b.body.length > 500, "returns the real (long) spec body");
    // the installed body is exactly the core spec (adapter only prepends frontmatter)
    const coreSpec = readFileSync(join(CORE, "agents", "developer-1.md"), "utf8").replace(/^﻿/, "").trimEnd();
    assert.equal(b.body, coreSpec, "brief body == the installed persona (core spec)");

    const notInstalled = agentBrief(CORE, dir, "design"); // real role, not in this roster
    assert.equal(notInstalled.installed, false, "design exists but isn't installed here");

    assert.throws(() => agentBrief(CORE, dir, "no-such-role"), /unknown role/, "an unknown role is rejected");
    assert.throws(() => agentBrief(CORE, dir, "../../etc/passwd"), /invalid role/, "a path-traversal role is rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("route matches a task to the right installed specialist by keywords", () => {
  const dir = project(); // full web-app team
  try {
    const r = routeTask(CORE, dir, "write unit tests for the payment module and prove the edge cases");
    assert.ok(r.candidates.length > 0, "found candidates");
    assert.equal(r.candidates[0].role, "testing", "the testing agent is the top match for a testing task");
    assert.ok(r.candidates[0].matched.includes("tests") || r.candidates[0].matched.includes("unit"), "reports which keywords matched");

    const sec = routeTask(CORE, dir, "audit the auth flow for injection and secret leaks");
    assert.equal(sec.candidates[0].role, "security", "a security task routes to the security gate");

    const design = routeTask(CORE, dir, "redesign the dashboard UI and improve the visual layout");
    assert.equal(design.candidates[0].role, "design", "a UI task routes to design");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("route only ever proposes INSTALLED agents, and flags a better-fit role you didn't install", () => {
  const dir = project(["--roles", "developer-1"]); // NO design, NO testing
  try {
    const r = routeTask(CORE, dir, "redesign the UI with a cleaner visual layout and better UX");
    const proposed = r.candidates.map((c) => c.role);
    assert.ok(!proposed.includes("design"), "never proposes design — it isn't installed");
    for (const c of r.candidates) {
      assert.ok(loadRoster(CORE, dir).roles.some((x) => x.role === c.role), `${c.role} is actually installed`);
    }
    assert.ok(r.missingTip && r.missingTip.role === "design", "honestly tips that `design` (not installed) is the closest fit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("route is deterministic and clamps limit; the flow opens with boss-1 and closes with the gates", () => {
  const dir = project();
  try {
    const a = routeTask(CORE, dir, "build and test a new API endpoint");
    const b = routeTask(CORE, dir, "build and test a new API endpoint");
    assert.deepEqual(a.candidates.map((c) => c.role), b.candidates.map((c) => c.role), "same task => same ranking");

    const big = routeTask(CORE, dir, "build and test a new API endpoint", { limit: 999 });
    assert.ok(big.candidates.length <= 6, "limit is clamped to 6");
    const one = routeTask(CORE, dir, "build and test a new API endpoint", { limit: 1 });
    assert.equal(one.candidates.length, 1, "limit 1 returns one candidate");

    assert.equal(a.flow[0].role, "boss-1", "the suggested pass opens with boss-1");
    const gateRoles = a.flow.map((f) => f.role);
    assert.ok(gateRoles.includes("critics") && gateRoles.includes("security"), "the always-on gates close the pass");
    assert.ok(gateRoles.lastIndexOf("critics") > 0, "gates come after boss-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the suggested pass never duplicates a role and never tells boss-1 to 'do the work'", () => {
  const dir = project();
  try {
    // a task that makes boss-1 ITSELF a strong keyword match — the exact case that duplicated it
    const r = routeTask(CORE, dir, "orchestrate the team, decompose this goal, delegate and integrate the results");
    const roles = r.flow.map((f) => f.role);
    assert.equal(new Set(roles).size, roles.length, "no role appears twice in the flow");
    const bossSteps = r.flow.filter((f) => f.role === "boss-1");
    assert.equal(bossSteps.length, 1, "boss-1 appears exactly once");
    assert.equal(roles[0], "boss-1", "and it's the opener");
    assert.ok(!/do the work/.test(bossSteps[0].note), "boss-1 is never told to do the work (it delegates)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a boss-2 that ranks as a top candidate also appears in the suggested pass (no candidate/flow drift)", () => {
  const dir = project();
  try {
    const r = routeTask(CORE, dir, "get an independent audit of this expensive decision before it reaches the owner");
    const topRoles = r.candidates.map((c) => c.role);
    assert.ok(topRoles.includes("boss-2"), "boss-2 is a top candidate for an independent-audit task");
    assert.ok(r.flow.some((f) => f.role === "boss-2"), "so it must also appear in the flow — candidates and flow agree");
    const roles = r.flow.map((f) => f.role);
    assert.equal(new Set(roles).size, roles.length, "and still no duplicate roles");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("route degrades honestly when nothing matches", () => {
  const dir = project();
  try {
    const r = routeTask(CORE, dir, "zzzzqqqq wubbalubbadubdub"); // no real keywords
    assert.equal(r.candidates.length, 0, "no fake matches");
    const res = call(dir, "route", { task: "zzzzqqqq wubbalubbadubdub" });
    assert.match(res.content[0].text, /boss-1/, "falls back to boss-1 as the router");
    assert.match(res.content[0].text, /not a judgment/, "is honest that it's keyword matching");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff returns the brief AND logs the delegation to the right team log", () => {
  const dir = project();
  try {
    const res = call(dir, "handoff", { role: "developer-1", task: "add a /health endpoint that checks the DB" });
    assert.ok(!res.isError, "handoff succeeds");
    const text = res.content[0].text;
    assert.match(text, /Handoff logged/, "confirms it logged");
    assert.match(text, /dev\/log\.md#\d+/, "developer-1 (dev team) is logged in the dev log");
    assert.match(text, /# developer-1/, "returns the agent's brief so the host can act on it");

    // the entry is actually on disk, correctly formatted
    const log = readFileSync(join(dir, "agent-memory", "dev", "log.md"), "utf8");
    assert.match(log, /Handoff → developer-1/, "the delegation is recorded verbatim");
    assert.match(log, /add a \/health endpoint/, "with the task");
    assert.match(log, /\*\*Task:\*\*/, "as a well-formed log entry");

    // security role (team review) logs to the review log, not dev
    const sec = call(dir, "handoff", { role: "security", task: "review the new endpoint" });
    assert.match(sec.content[0].text, /review\/log\.md#\d+/, "a review-team role logs in the review log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff refuses a role that isn't installed, and does NOT write a log entry", () => {
  const dir = project(["--roles", "developer-1"]); // no design
  try {
    const res = call(dir, "handoff", { role: "design", task: "make it pretty" });
    assert.ok(res.isError, "refuses an uninstalled role");
    assert.match(res.content[0].text, /not installed|venom add design/, "tells the user how to add it");
    // nothing was written — check for the delegation marker, not a bare "design" (the log seed mentions it)
    const devLog = join(dir, "agent-memory", "dev", "log.md");
    if (existsSync(devLog)) assert.ok(!/Handoff →/.test(readFileSync(devLog, "utf8")), "no phantom delegation entry logged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logTeamForRole maps org teams onto real logs (orchestration -> review)", () => {
  assert.equal(logTeamForRole(CORE, "developer-1"), "dev");
  assert.equal(logTeamForRole(CORE, "tech-researcher"), "research");
  assert.equal(logTeamForRole(CORE, "critics"), "review");
  assert.equal(logTeamForRole(CORE, "threat-modeler"), "security");
  assert.equal(logTeamForRole(CORE, "boss-1"), "review", "orchestration has no log; boss dispatches land in review");
});

test("router tools compose with a custom roster end-to-end via the JSON-RPC layer", () => {
  const dir = project(["--roles", "developer-1,testing,technical-writer"]);
  try {
    const list = call(dir, "list_agents").content[0].text;
    assert.match(list, /Installed agents \(7\)/); // core 4 + 3
    const route = call(dir, "route", { task: "document the release and test the changelog examples" }).content[0].text;
    // the design AGENT must never be PROPOSED (as a candidate or flow line) — it isn't installed.
    // (Check the role LINE "N. design —", not a bare "design" that can appear inside a spec excerpt.)
    assert.ok(!/\d+\.\s+design\b/m.test(route), "route never proposes the uninstalled design agent");
    assert.match(route, /\d+\.\s+(testing|technical-writer)\b/m, "the installed specialists are reachable");
    const brief = call(dir, "agent_brief", { role: "technical-writer" }).content[0].text;
    assert.match(brief, /technical-writer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
