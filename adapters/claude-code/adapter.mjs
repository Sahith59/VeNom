// Venom — Claude Code adapter.
// Self-contained, zero-dependency ESM. Given the tool-agnostic core + a chosen pack + a filled
// Charter, it renders a working Claude Code setup into a target project:
//   .claude/agents/<role>.md   (portable spec body + Claude Code frontmatter from manifest.json)
//   .claude/settings.json       (safe permissions; merged, never clobbered)
//   CHARTER.md                  (the project's constitution; never clobbered if it exists)
//   CLAUDE.md                   (lead-session brief that imports the Charter; managed block only)
//   agent-memory/               (the memory tier; copied, never overwriting live memory)
//   .venom/workflow.md + install.json  (the human's guide + install record for updates)
//
// It is designed to be safe to re-run: your own edits outside the managed markers survive, live
// memory is preserved, and switching packs cleans up only the agents Venom itself installed.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));

export const meta = {
  id: "claude-code",
  name: "Claude Code",
  agentsDir: ".claude/agents",
  settingsPath: ".claude/settings.json",
  startHint:
    "Open this project in Claude Code and give BOSS-1 your first goal — the lead session operates as BOSS-1 per CLAUDE.md, and each role is a subagent in .claude/agents/.",
  // Heuristic the CLI can use to auto-detect this tool in a project.
  detect(targetDir) {
    return existsSync(join(targetDir, ".claude")) || existsSync(join(targetDir, "CLAUDE.md"));
  },
};

const VENOM_BEGIN = "<!-- VENOM:BEGIN";
const VENOM_END = "<!-- VENOM:END -->";

// Role names become path segments (.claude/agents/<role>.md) and must be safe slugs, so a crafted
// pack or a tampered install.json can never traverse out of the managed directory.
const SAFE_ROLE = /^[a-z0-9][a-z0-9-]*$/;

function yamlString(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function renderFrontmatter(name, m) {
  const lines = ["---", `name: ${name}`, `description: ${yamlString(m.description)}`, `model: ${m.model}`];
  if (Array.isArray(m.tools) && m.tools.length) lines.push(`tools: ${m.tools.join(", ")}`);
  lines.push("---", "");
  return lines.join("\n");
}

function uniq(arr) {
  return [...new Set(arr)];
}

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// Recursively copy src -> dest, but never overwrite a file that already exists in dest.
// Preserves the user's live memory when re-running init.
function copyIfAbsent(src, dest) {
  ensureDir(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyIfAbsent(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}

// Replace the managed VENOM block in an existing CLAUDE.md, or append it; create the file if absent.
function writeManagedClaudeMd(path, fullRendered, blockOnly) {
  if (!existsSync(path)) {
    writeFileSync(path, fullRendered.endsWith("\n") ? fullRendered : fullRendered + "\n");
    return "created";
  }
  const current = readFileSync(path, "utf8");
  const b = current.indexOf(VENOM_BEGIN);
  const e = current.indexOf(VENOM_END);
  if (b !== -1 && e !== -1 && e > b) {
    const updated = current.slice(0, b) + blockOnly + current.slice(e + VENOM_END.length);
    writeFileSync(path, updated);
    return "updated";
  }
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, current + sep + blockOnly + "\n");
  return "appended";
}

// Union the Venom permission rules into an existing settings.json without dropping the user's keys.
function mergeSettings(path, template) {
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(template, null, 2) + "\n");
    return "created";
  }
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} exists but is not valid JSON; refusing to overwrite it. Fix or remove it and re-run.`);
  }
  existing.permissions = existing.permissions || {};
  for (const bucket of ["allow", "ask", "deny"]) {
    existing.permissions[bucket] = uniq([
      ...(existing.permissions[bucket] || []),
      ...((template.permissions && template.permissions[bucket]) || []),
    ]);
  }
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  return "merged";
}

/**
 * Install a Venom team into targetDir for Claude Code.
 * @param {object} opts
 * @param {string} opts.coreDir      - path to Venom's core/ (agents/, memory-template/, workflow.md, packs.json)
 * @param {string} opts.targetDir    - the project to install into
 * @param {string} opts.pack         - pack id (e.g. "web-app")
 * @param {string} opts.charterContent - the filled CHARTER.md content
 * @param {string} [opts.projectName]  - used in the CLAUDE.md title
 * @param {string[]} [opts.extraRoles] - individual roles to add on top of the pack (e.g. ["marketing"])
 * @param {string[]} [opts.removeRoles]- individual roles to drop from the pack
 * @param {boolean} [opts.force]       - overwrite an existing CHARTER.md
 * @param {string} [opts.version]      - venomkit version, recorded in .venom/install.json
 * @param {string} [opts.now]          - ISO timestamp (CLI supplies; keeps install deterministic/testable)
 * @returns {{roles:string[], agentsWritten:number, actions:object, warnings:string[]}}
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
  const manifest = JSON.parse(readFileSync(join(ADAPTER_DIR, "manifest.json"), "utf8"));
  if (!packs.packs[pack]) {
    throw new Error(`unknown pack "${pack}". Available: ${Object.keys(packs.packs).join(", ")}`);
  }

  // Resolve the role set for this pack, honoring extra/remove.
  const roles = uniq([...packs.core, ...packs.packs[pack].adds, ...extraRoles])
    .filter((r) => !removeRoles.includes(r));

  // Validate every role is a safe slug with both a spec file and a manifest entry before writing.
  for (const r of roles) {
    if (!SAFE_ROLE.test(r)) throw new Error(`unsafe role name "${r}" — role names must match ${SAFE_ROLE}`);
    if (!existsSync(join(coreDir, "agents", `${r}.md`))) throw new Error(`role "${r}" has no spec at core/agents/${r}.md`);
    if (!manifest.agents[r]) throw new Error(`role "${r}" has no entry in the Claude Code manifest`);
  }

  const agentsDir = join(targetDir, ".claude", "agents");
  ensureDir(agentsDir);

  // Clean up agents that a previous Venom install wrote but that this pack no longer includes.
  const installRecordPath = join(targetDir, ".venom", "install.json");
  if (existsSync(installRecordPath)) {
    try {
      const prev = JSON.parse(readFileSync(installRecordPath, "utf8"));
      for (const r of prev.managedAgents || []) {
        if (roles.includes(r)) continue;
        if (!SAFE_ROLE.test(r)) { warnings.push(`skipped cleanup of suspicious managed entry "${r}"`); continue; }
        const stale = join(agentsDir, `${r}.md`);
        if (existsSync(stale)) rmSync(stale);
      }
    } catch {
      warnings.push("could not read previous .venom/install.json; skipped stale-agent cleanup");
    }
  }

  // 1) Render agents.
  for (const r of roles) {
    const body = readFileSync(join(coreDir, "agents", `${r}.md`), "utf8");
    writeFileSync(join(agentsDir, `${r}.md`), renderFrontmatter(r, manifest.agents[r]) + body.replace(/^﻿/, ""));
  }

  // 2) Settings (safe merge).
  const settingsTemplate = JSON.parse(readFileSync(join(ADAPTER_DIR, "settings.template.json"), "utf8"));
  const settingsAction = mergeSettings(join(targetDir, ".claude", "settings.json"), settingsTemplate);

  // 3) Charter (never clobber unless forced).
  const charterPath = join(targetDir, "CHARTER.md");
  let charterAction;
  if (!existsSync(charterPath) || force) {
    writeFileSync(charterPath, charterContent.endsWith("\n") ? charterContent : charterContent + "\n");
    charterAction = existsSync(charterPath) && !force ? "created" : (force ? "overwritten" : "created");
  } else {
    charterAction = "kept (existing)";
    warnings.push("CHARTER.md already existed and was kept; pass force to overwrite.");
  }

  // 4) CLAUDE.md lead-session brief (managed block).
  const tpl = readFileSync(join(ADAPTER_DIR, "CLAUDE.md.template"), "utf8").replace(/\{\{PROJECT_NAME\}\}/g, projectName);
  const b = tpl.indexOf(VENOM_BEGIN);
  const e = tpl.indexOf(VENOM_END);
  const blockOnly = tpl.slice(b, e + VENOM_END.length);
  const claudeAction = writeManagedClaudeMd(join(targetDir, "CLAUDE.md"), tpl, blockOnly);

  // 5) Memory tier (copy, never overwrite live memory).
  copyIfAbsent(join(coreDir, "memory-template"), join(targetDir, "agent-memory"));

  // 6) Venom home: the human's workflow guide + the install record.
  const venomDir = join(targetDir, ".venom");
  ensureDir(venomDir);
  copyFileSync(join(coreDir, "workflow.md"), join(venomDir, "workflow.md"));
  const record = {
    tool: "claude-code",
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
    { label: "agents", path: ".claude/agents/", note: roles.join(", ") },
    { label: "charter", path: "CHARTER.md", note: charterAction },
    { label: "brief", path: "CLAUDE.md", note: claudeAction },
    { label: "perms", path: ".claude/settings.json", note: settingsAction },
    { label: "memory", path: "agent-memory/", note: "" },
    { label: "guide", path: ".venom/workflow.md", note: "" },
  ];

  return {
    roles,
    agentsWritten: roles.length,
    actions: { settings: settingsAction, charter: charterAction, claudeMd: claudeAction },
    warnings,
    layout,
  };
}

export default { meta, install };
