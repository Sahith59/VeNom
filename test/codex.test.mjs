// End-to-end test for the Codex adapter. Real installs into temp projects, no mocks.
// Run: node --test test/codex.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { install, meta } from "../adapters/codex/adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, "..", "core");
const CHARTER = "# My Project — Team Charter\n\nWe build a thing. Non-negotiables: be honest.\n";
const NOW = "2026-07-03T00:00:00.000Z";

function fresh() {
  return mkdtempSync(join(tmpdir(), "venom-codex-"));
}

test("web-app install writes AGENTS.md + verbatim role specs + all surfaces", () => {
  const t = fresh();
  try {
    const r = install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, projectName: "My Project", version: "9.9.9", now: NOW });

    assert.equal(r.agentsWritten, 14, "web-app has 14 roles");
    for (const role of ["boss-1", "boss-2", "critics", "security", "dev-head", "developer-1", "design", "technical-writer"]) {
      assert.ok(existsSync(join(t, ".venom", "agents", `${role}.md`)), `${role} spec written`);
    }
    assert.ok(!existsSync(join(t, ".venom", "agents", "data-engineer.md")), "data-engineer NOT in web-app");

    // specs are verbatim copies of core (portable, tool-agnostic)
    const coreBoss = readFileSync(join(CORE, "agents", "boss-1.md"), "utf8").replace(/^﻿/, "");
    const outBoss = readFileSync(join(t, ".venom", "agents", "boss-1.md"), "utf8");
    assert.equal(outBoss.trimEnd(), coreBoss.trimEnd(), "boss-1 spec copied verbatim");

    // AGENTS.md is the managed brief with roster + pack + gates
    const agents = readFileSync(join(t, "AGENTS.md"), "utf8");
    assert.match(agents, /VENOM:BEGIN/);
    assert.match(agents, /VENOM:END/);
    assert.match(agents, /My Project/, "project name filled");
    assert.match(agents, /Web \/ App Development/, "pack name filled");
    assert.match(agents, /`boss-1` — Primary Orchestrator/, "roster row rendered from catalog");
    assert.ok(!/\{\{/.test(agents), "no unfilled placeholders remain");
    assert.match(agents, /critics/, "mentions the critics gate");
    assert.match(agents, /security/, "mentions the security gate");
    assert.match(agents, /\.venom\/agents\//, "points at the role specs");
    for (const role of ["boss-1", "developer-1", "technical-writer"]) {
      assert.match(agents, new RegExp(`\\\`${role}\\\``), `roster lists ${role}`);
    }

    // charter + memory + venom home
    assert.equal(readFileSync(join(t, "CHARTER.md"), "utf8").trim(), CHARTER.trim());
    for (const f of ["README.md", "SNAPSHOT.md", "INDEX.md", join("dev", "log.md"), join("review", "log.md")]) {
      assert.ok(existsSync(join(t, "agent-memory", f)), `agent-memory/${f} present`);
    }
    assert.ok(existsSync(join(t, ".venom", "workflow.md")), "workflow guide placed");
    const rec = JSON.parse(readFileSync(join(t, ".venom", "install.json"), "utf8"));
    assert.equal(rec.tool, "codex");
    assert.equal(rec.pack, "web-app");
    assert.equal(rec.roles.length, 14);
    assert.equal(rec.installedAt, NOW);

    // layout returned for the CLI
    assert.ok(Array.isArray(r.layout) && r.layout.some((i) => i.path === "AGENTS.md"), "layout describes AGENTS.md");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("re-run is idempotent — exactly one managed block", () => {
  const t = fresh();
  try {
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    const agents = readFileSync(join(t, "AGENTS.md"), "utf8");
    assert.equal(agents.split("VENOM:BEGIN").length - 1, 1, "one managed block after re-run");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("switching packs cleans up stale role specs", () => {
  const t = fresh();
  try {
    install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    assert.ok(existsSync(join(t, ".venom", "agents", "design.md")), "design present under web-app");
    install({ coreDir: CORE, targetDir: t, pack: "solo-minimal", charterContent: CHARTER, now: NOW });
    assert.ok(!existsSync(join(t, ".venom", "agents", "design.md")), "design removed after switch");
    assert.ok(!existsSync(join(t, ".venom", "agents", "developer-2.md")), "developer-2 removed");
    assert.ok(existsSync(join(t, ".venom", "agents", "developer-1.md")), "developer-1 kept");
    assert.ok(existsSync(join(t, ".venom", "agents", "boss-1.md")), "core kept");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("no-clobber: user content outside markers and a pre-existing charter survive", () => {
  const t = fresh();
  try {
    writeFileSync(join(t, "AGENTS.md"), "# My repo\n\nMY OWN AGENTS NOTE that must survive.\n");
    writeFileSync(join(t, "CHARTER.md"), "MY EXISTING CHARTER\n");
    const r = install({ coreDir: CORE, targetDir: t, pack: "web-app", charterContent: CHARTER, now: NOW });
    const agents = readFileSync(join(t, "AGENTS.md"), "utf8");
    assert.match(agents, /MY OWN AGENTS NOTE that must survive/, "user note preserved");
    assert.match(agents, /VENOM:BEGIN/, "venom block appended");
    assert.equal(readFileSync(join(t, "CHARTER.md"), "utf8").trim(), "MY EXISTING CHARTER", "existing charter kept");
    assert.ok(r.warnings.some((w) => /CHARTER\.md already existed/.test(w)), "warned about kept charter");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("EVERY pack installs with the right spec count", () => {
  const packs = JSON.parse(readFileSync(join(CORE, "packs.json"), "utf8"));
  for (const [id, pk] of Object.entries(packs.packs)) {
    const t = fresh();
    try {
      const r = install({ coreDir: CORE, targetDir: t, pack: id, charterContent: CHARTER, now: NOW });
      const expected = packs.core.length + pk.adds.length;
      assert.equal(r.agentsWritten, expected, `${id} agentsWritten`);
      const files = readdirSync(join(t, ".venom", "agents")).filter((f) => f.endsWith(".md"));
      assert.equal(files.length, expected, `${id} specs on disk`);
    } finally { rmSync(t, { recursive: true, force: true }); }
  }
});

test("meta.detect keys on .codex/, not a cross-tool AGENTS.md", () => {
  const t = fresh();
  try {
    assert.equal(meta.detect(t), false, "empty dir not detected");
    writeFileSync(join(t, "AGENTS.md"), "x");
    assert.equal(meta.detect(t), false, "bare AGENTS.md is NOT a Codex signal");
    mkdirSync(join(t, ".codex"), { recursive: true });
    assert.equal(meta.detect(t), true, ".codex/ detected");
  } finally { rmSync(t, { recursive: true, force: true }); }
});
