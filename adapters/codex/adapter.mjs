// Venom — Codex adapter.
// Self-contained, zero-dependency ESM. Maps Venom's tool-agnostic core into a working Codex setup.
//
// Codex reads `AGENTS.md` at the repo root automatically, so that file is the team's brain here: it
// briefs the single Codex agent to operate as the Venom team (boss-1 by default), points at each
// role's full spec, and encodes the shared-memory protocol and the two review gates. The individual
// role specs are written verbatim to `.venom/agents/` so any role can be adopted in full.
//
//   AGENTS.md            (team briefing + roster; managed block only, your notes survive)
//   .venom/agents/<role>.md  (each pack role's portable spec, verbatim)
//   CHARTER.md           (the project's constitution; never clobbered if it exists)
//   agent-memory/        (the memory tier; copied, never overwriting live memory)
//   .venom/workflow.md + install.json
//
// Fidelity note: Claude Code enforces per-role tool limits (read-only gates, no-exec advisors) via
// tool permissions. Codex has no per-role permission layer, so those limits are carried as explicit
// instructions in AGENTS.md and each spec, and Codex's own `--sandbox`/`--ask-for-approval` flags do
// the runtime enforcement. Same team, honestly mapped to what Codex actually provides.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));

export const meta = {
  id: "codex",
  name: "Codex",
  agentsDir: ".venom/agents",
  settingsPath: "AGENTS.md",
  startHint:
    "Open this project in Codex and give it your first goal — it operates as BOSS-1 per AGENTS.md. For safety, run Codex with `--sandbox workspace-write --ask-for-approval on-request`.",
  detect(targetDir) {
    // AGENTS.md is a cross-tool convention, so only the Codex-specific .codex/ dir signals Codex.
    return existsSync(join(targetDir, ".codex"));
  },
};

const VENOM_BEGIN = "<!-- VENOM:BEGIN";
const VENOM_END = "<!-- VENOM:END -->";

// Role names become path segments (.venom/agents/<role>.md) and must be safe slugs, so a crafted
// pack or a tampered install.json can never traverse out of the managed directory.
const SAFE_ROLE = /^[a-z0-9][a-z0-9-]*$/;

function uniq(arr) {
  return [...new Set(arr)];
}

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function stripBom(s) {
  return s.replace(/^﻿/, "");
}

// Recursively copy src -> dest, never overwriting a file that already exists (preserves live memory).
function copyIfAbsent(src, dest) {
  ensureDir(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyIfAbsent(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}

// Replace the managed VENOM block in an existing file, or append it; create the file if absent.
function writeManagedDoc(path, fullRendered, blockOnly) {
  if (!existsSync(path)) {
    writeFileSync(path, fullRendered.endsWith("\n") ? fullRendered : fullRendered + "\n");
    return "created";
  }
  const current = readFileSync(path, "utf8");
  const b = current.indexOf(VENOM_BEGIN);
  const e = current.indexOf(VENOM_END);
  if (b !== -1 && e !== -1 && e > b) {
    writeFileSync(path, current.slice(0, b) + blockOnly + current.slice(e + VENOM_END.length));
    return "updated";
  }
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, current + sep + blockOnly + "\n");
  return "appended";
}

// Build the Markdown roster table from the roles catalog: `role — Title | summary`.
function renderRoster(roles, catalog) {
  const rows = ["| Role | What it does |", "|------|--------------|"];
  for (const r of roles) {
    const meta = catalog[r] || {};
    const title = meta.title || r;
    const summary = (meta.summary || "").replace(/\|/g, "\\|");
    rows.push(`| \`${r}\` — ${title} | ${summary} |`);
  }
  return rows.join("\n");
}

/**
 * Install a Venom team into targetDir for Codex. Same option contract as every Venom adapter.
 * @returns {{roles:string[], agentsWritten:number, actions:object, warnings:string[], layout:object[]}}
 */
export function install(opts) {
  const {
    coreDir, targetDir, pack, charterContent,
    projectName = "This project", extraRoles = [], removeRoles = [],
    force = false, version = "0.0.0", now,
  } = opts;

  const warnings = [];
  if (!coreDir || !existsSync(coreDir)) throw new Error(`coreDir not found: ${coreDir}`);
  if (!targetDir) throw new Error("targetDir is required");

  const packs = JSON.parse(readFileSync(join(coreDir, "packs.json"), "utf8"));
  if (!packs.packs[pack]) {
    throw new Error(`unknown pack "${pack}". Available: ${Object.keys(packs.packs).join(", ")}`);
  }

  const roles = uniq([...packs.core, ...packs.packs[pack].adds, ...extraRoles])
    .filter((r) => !removeRoles.includes(r));

  // Validate every role is a safe slug with a spec + a catalog entry before writing anything.
  for (const r of roles) {
    if (!SAFE_ROLE.test(r)) throw new Error(`unsafe role name "${r}" — role names must match ${SAFE_ROLE}`);
    if (!existsSync(join(coreDir, "agents", `${r}.md`))) throw new Error(`role "${r}" has no spec at core/agents/${r}.md`);
    if (!packs.roles[r]) throw new Error(`role "${r}" has no entry in the packs.json roles catalog`);
  }

  const specsDir = join(targetDir, ".venom", "agents");
  ensureDir(specsDir);

  // Clean up specs a previous Venom install wrote but that this pack no longer includes.
  const installRecordPath = join(targetDir, ".venom", "install.json");
  if (existsSync(installRecordPath)) {
    try {
      const prev = JSON.parse(readFileSync(installRecordPath, "utf8"));
      for (const r of prev.managedAgents || []) {
        if (roles.includes(r)) continue;
        if (!SAFE_ROLE.test(r)) { warnings.push(`skipped cleanup of suspicious managed entry "${r}"`); continue; }
        const stale = join(specsDir, `${r}.md`);
        if (existsSync(stale)) rmSync(stale);
      }
    } catch {
      warnings.push("could not read previous .venom/install.json; skipped stale-spec cleanup");
    }
  }

  // 1) Role specs — the portable bodies, verbatim (identical to core; Codex reads them on demand).
  for (const r of roles) {
    const body = stripBom(readFileSync(join(coreDir, "agents", `${r}.md`), "utf8"));
    writeFileSync(join(specsDir, `${r}.md`), body.endsWith("\n") ? body : body + "\n");
  }

  // 2) AGENTS.md — the orchestration brief Codex auto-loads (managed block only).
  const tpl = readFileSync(join(ADAPTER_DIR, "AGENTS.template.md"), "utf8")
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{PACK_NAME\}\}/g, packs.packs[pack].name)
    .replace(/\{\{ROSTER\}\}/g, renderRoster(roles, packs.roles));
  const b = tpl.indexOf(VENOM_BEGIN);
  const e = tpl.indexOf(VENOM_END);
  const blockOnly = tpl.slice(b, e + VENOM_END.length);
  const agentsAction = writeManagedDoc(join(targetDir, "AGENTS.md"), tpl, blockOnly);

  // 3) Charter (never clobber unless forced).
  const charterPath = join(targetDir, "CHARTER.md");
  let charterAction;
  if (!existsSync(charterPath) || force) {
    writeFileSync(charterPath, charterContent.endsWith("\n") ? charterContent : charterContent + "\n");
    charterAction = force && existsSync(charterPath) ? "overwritten" : "created";
  } else {
    charterAction = "kept (existing)";
    warnings.push("CHARTER.md already existed and was kept; pass force to overwrite.");
  }

  // 4) Memory tier (copy, never overwrite live memory).
  copyIfAbsent(join(coreDir, "memory-template"), join(targetDir, "agent-memory"));

  // 5) Venom home: the human's workflow guide + the install record.
  const venomDir = join(targetDir, ".venom");
  ensureDir(venomDir);
  copyFileSync(join(coreDir, "workflow.md"), join(venomDir, "workflow.md"));
  const record = {
    tool: "codex",
    version,
    pack,
    roles,
    extraRoles,
    removeRoles,
    managedAgents: roles,
    installedAt: now || new Date().toISOString(),
  };
  writeFileSync(installRecordPath, JSON.stringify(record, null, 2) + "\n");

  const layout = [
    { label: "team", path: "AGENTS.md", note: agentsAction },
    { label: "specs", path: ".venom/agents/", note: roles.join(", ") },
    { label: "charter", path: "CHARTER.md", note: charterAction },
    { label: "memory", path: "agent-memory/", note: "" },
    { label: "guide", path: ".venom/workflow.md", note: "" },
  ];

  return {
    roles,
    agentsWritten: roles.length,
    actions: { agentsMd: agentsAction, charter: charterAction },
    warnings,
    layout,
  };
}

export default { meta, install };
