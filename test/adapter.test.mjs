// End-to-end test for the Claude Code adapter. Runs a real install into a temp project and asserts
// the output — no mocks. Run: node --test test/adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { install, meta } from "../adapters/claude-code/adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = join(HERE, "..", "adapters", "claude-code");
const CORE = join(HERE, "..", "core");
const CHARTER = "# My Project — Team Charter\n\nWe build a thing. Non-negotiables: be honest.\n";
const NOW = "2026-07-02T00:00:00.000Z";

function fresh() {
  return mkdtempSync(join(tmpdir(), "venom-test-"));
}
function fm(target, role) {
  // return the YAML frontmatter block of a rendered agent
  const txt = readFileSync(join(target, ".claude", "agents", `${role}.md`), "utf8");
  assert.ok(txt.startsWith("---\n"), `${role} must start with frontmatter`);
  return txt.slice(0, txt.indexOf("\n---", 4) + 4);
}

test("web-app install writes the full team + all surfaces", () => {
  const t = fresh();
  try {
    const r = install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, projectName: "My Project", version: "9.9.9", now: NOW });

    assert.equal(r.agentsWritten, 14, "web-app has 14 agents");
    // core four + a couple pack roles present; a data-ml-only role absent
    for (const role of ["boss-1", "boss-2", "critics", "security", "dev-head", "developer-1", "design", "technical-writer"]) {
      assert.ok(existsSync(join(t, ".claude", "agents", `${role}.md`)), `${role} installed`);
    }
    assert.ok(!existsSync(join(t, ".claude", "agents", "data-engineer.md")), "data-engineer NOT in web-app");

    // frontmatter correctness
    const bossFm = fm(t, "boss-1");
    assert.match(bossFm, /name: boss-1/);
    assert.match(bossFm, /model: opus/);
    assert.match(bossFm, /description: "/, "description is quoted");
    assert.ok(!/tools:/.test(bossFm), "boss-1 has no tools line (all tools)");

    const criticsFm = fm(t, "critics");
    assert.match(criticsFm, /model: opus/);
    assert.match(criticsFm, /tools: Read, Glob, Grep, Bash, WebSearch, WebFetch/);
    assert.ok(!/Edit|Write/.test(criticsFm.split("tools:")[1]), "read-only gate has no Edit/Write");

    const devFm = fm(t, "developer-1");
    assert.match(devFm, /model: sonnet/);
    assert.match(devFm, /tools: .*Edit.*Write.*Bash/);

    // the body survived after the frontmatter
    const bossFull = readFileSync(join(t, ".claude", "agents", "boss-1.md"), "utf8");
    assert.match(bossFull, /# BOSS-1 — Primary Orchestrator/);

    // settings.json valid + safe
    const s = JSON.parse(readFileSync(join(t, ".claude", "settings.json"), "utf8"));
    assert.ok(s.permissions.allow.includes("Read"));
    assert.ok(s.permissions.ask.includes("Write"));
    assert.ok(s.permissions.deny.includes("Bash(git push:*)"), "push is denied");
    assert.ok(s.permissions.deny.some((d) => d.includes(".env")), ".env reads denied");

    // charter + CLAUDE.md
    assert.equal(readFileSync(join(t, "CHARTER.md"), "utf8").trim(), CHARTER.trim());
    const claude = readFileSync(join(t, "CLAUDE.md"), "utf8");
    assert.match(claude, /VENOM:BEGIN/);
    assert.match(claude, /VENOM:END/);
    assert.match(claude, /@CHARTER\.md/, "imports the charter");
    assert.match(claude, /My Project/);
    assert.match(claude, /operate as \*\*BOSS-1\*\*/);

    // memory tier copied
    for (const f of ["README.md", "SNAPSHOT.md", "INDEX.md", join("dev", "log.md"), join("review", "log.md"), join("lessons", "dev.md"), "decisions/needed.md"]) {
      assert.ok(existsSync(join(t, "agent-memory", f)), `agent-memory/${f} present`);
    }

    // venom home + record
    assert.ok(existsSync(join(t, ".venom", "workflow.md")), "workflow guide placed");
    const rec = JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8"));
    assert.equal(rec.pack, "web-app");
    assert.equal(rec.roles.length, 14);
    assert.equal(rec.installedAt, NOW);
    assert.equal(rec.tool, "claude-code");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("re-run is idempotent — one managed block, same agents", () => {
  const t = fresh();
  try {
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    const claude = readFileSync(join(t, "CLAUDE.md"), "utf8");
    assert.equal(claude.split("VENOM:BEGIN").length - 1, 1, "exactly one managed block after re-run");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("switching packs cleans up stale agents", () => {
  const t = fresh();
  try {
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    assert.ok(existsSync(join(t, ".claude", "agents", "design.md")), "design present under web-app");
    install({ coreDir: CORE, targetDir: t, pack: "solo-minimal", charterContent: CHARTER, now: NOW });
    assert.ok(!existsSync(join(t, ".claude", "agents", "design.md")), "design removed after switch to solo-minimal");
    assert.ok(!existsSync(join(t, ".claude", "agents", "developer-2.md")), "developer-2 removed");
    assert.ok(existsSync(join(t, ".claude", "agents", "developer-1.md")), "developer-1 kept");
    assert.ok(existsSync(join(t, ".claude", "agents", "boss-1.md")), "core kept");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("no-clobber: user content outside the markers and a pre-existing charter survive", () => {
  const t = fresh();
  try {
    // pre-existing CLAUDE.md with the user's own note, and a pre-existing charter
    writeFileSync(join(t, "CLAUDE.md"), "# My repo\n\nMY OWN NOTE that must survive.\n");
    writeFileSync(join(t, "CHARTER.md"), "MY EXISTING CHARTER\n");
    const r = install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    const claude = readFileSync(join(t, "CLAUDE.md"), "utf8");
    assert.match(claude, /MY OWN NOTE that must survive/, "user note preserved");
    assert.match(claude, /VENOM:BEGIN/, "venom block appended");
    assert.equal(readFileSync(join(t, "CHARTER.md"), "utf8").trim(), "MY EXISTING CHARTER", "existing charter kept");
    assert.ok(r.warnings.some((w) => /CHARTER\.md already existed/.test(w)), "warned about kept charter");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("settings merge preserves the user's existing rules", () => {
  const t = fresh();
  try {
    mkdirSync(join(t, ".claude"), { recursive: true });
    writeFileSync(join(t, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(mycmd:*)"] }, env: { FOO: "bar" } }, null, 2));
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    const s = JSON.parse(readFileSync(join(t, ".claude", "settings.json"), "utf8"));
    assert.ok(s.permissions.allow.includes("Bash(mycmd:*)"), "user's allow rule kept");
    assert.ok(s.permissions.allow.includes("Read"), "venom allow rule added");
    assert.ok(s.permissions.deny.includes("Bash(git push:*)"), "venom deny rule added");
    assert.equal(s.env.FOO, "bar", "unrelated user keys preserved");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("meta.detect works", () => {
  const t = fresh();
  try {
    assert.equal(meta.detect(t), false, "empty dir not detected");
    mkdirSync(join(t, ".claude"), { recursive: true });
    assert.equal(meta.detect(t), true, ".claude detected");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

const KNOWN_TOOLS = new Set(["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "WebFetch"]);
const DESC_LINE = /^description: "(?:[^"\\]|\\.)*"$/; // quoted + balanced

test("EVERY pack installs with the right count and valid frontmatter", () => {
  const packs = JSON.parse(readFileSync(join(CORE, "packs.json"), "utf8"));
  for (const [id, pk] of Object.entries(packs.packs)) {
    const t = fresh();
    try {
      const r = install({ coreDir: CORE, targetDir: t, pack: id, charterContent: CHARTER, now: NOW });
      const expected = packs.core.length + pk.adds.length;
      assert.equal(r.agentsWritten, expected, `${id} agentsWritten`);
      const files = readdirSync(join(t, ".claude", "agents")).filter((f) => f.endsWith(".md"));
      assert.equal(files.length, expected, `${id} files on disk`);
      for (const f of files) {
        const role = f.replace(/\.md$/, "");
        const txt = readFileSync(join(t, ".claude", "agents", f), "utf8");
        assert.ok(txt.startsWith("---\n"), `${id}/${role} fm start`);
        const end = txt.indexOf("\n---\n", 4);
        assert.ok(end > 0, `${id}/${role} fm end`);
        const lines = txt.slice(4, end).split("\n");
        assert.ok(lines.includes(`name: ${role}`), `${role} name matches filename`);
        assert.ok(lines.some((l) => /^model: (opus|sonnet)$/.test(l)), `${role} valid model`);
        assert.ok(lines.some((l) => DESC_LINE.test(l)), `${role} description quoted + balanced`);
        const toolsLine = lines.find((l) => l.startsWith("tools:"));
        if (toolsLine) for (const tool of toolsLine.slice(6).split(",").map((s) => s.trim())) {
          assert.ok(KNOWN_TOOLS.has(tool), `${role} references unknown tool "${tool}"`);
        }
        assert.match(txt.slice(end), /# [A-Z]/, `${role} spec body present after frontmatter`);
      }
    } finally { rmSync(t, { recursive: true, force: true }); }
  }
});

test("manifest, specs, and packs catalog are the same 23 roles; models + tool-safety hold", () => {
  const packs = JSON.parse(readFileSync(join(CORE, "packs.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ADAPTER_DIR, "manifest.json"), "utf8"));
  const specs = readdirSync(join(CORE, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  assert.equal(specs.length, 23, "23 spec files");
  assert.deepEqual(Object.keys(manifest.agents).sort(), specs, "manifest == specs");
  assert.deepEqual(Object.keys(packs.roles).sort(), specs, "catalog == specs");
  const OPUS = new Set(["boss-1", "boss-2", "critics", "security"]);
  for (const [role, m] of Object.entries(manifest.agents)) {
    assert.ok(["opus", "sonnet"].includes(m.model), `${role} model valid`);
    assert.equal(m.model === "opus", OPUS.has(role), `${role}: opus iff checkpoint role`);
    const tools = m.tools || null;
    if (role === "critics" || role === "security") {
      assert.ok(tools && !tools.includes("Edit") && !tools.includes("Write"), `${role} is read-only (no Edit/Write)`);
    }
    if (role === "threat-modeler" || role === "pentester-advisor") {
      assert.ok(tools && !tools.includes("Bash"), `${role} cannot execute (no Bash)`);
    }
  }
});

test("optional marketing add-on renders via extraRoles", () => {
  const t = fresh();
  try {
    const r = install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, extraRoles: ["marketing"], now: NOW });
    assert.ok(r.roles.includes("marketing"), "marketing added");
    assert.equal(r.agentsWritten, 15, "14 + marketing");
    assert.ok(existsSync(join(t, ".claude", "agents", "marketing.md")), "marketing rendered");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("settings.template.json is strict JSON with no non-standard keys", () => {
  const s = JSON.parse(readFileSync(join(ADAPTER_DIR, "settings.template.json"), "utf8"));
  assert.deepEqual(Object.keys(s), ["permissions"], "only the permissions key");
  for (const b of ["allow", "ask", "deny"]) assert.ok(Array.isArray(s.permissions[b]), `${b} is an array`);
});
