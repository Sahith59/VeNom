// Venom — Gemini CLI adapter.
// Self-contained, zero-dependency ESM. Maps Venom's tool-agnostic core into a working Gemini CLI setup.
//
// Gemini loads `GEMINI.md` as hierarchical context automatically (it is Gemini's default context
// file), and runs TOML files under `.gemini/commands/` as custom slash commands. So each Venom role
// becomes a real, native command: typing `/venom:security` makes Gemini adopt the security auditor
// with its full operating spec.
//
//   GEMINI.md                        (team briefing + roster; managed block only, your notes survive)
//   .gemini/commands/venom/<role>.toml  (one slash command per pack role: /venom:<role>)
//   CHARTER.md                       (the project's constitution; never clobbered if it exists)
//   agent-memory/                    (the memory tier; copied, never overwriting live memory)
//   .venom/workflow.md + install.json
//
// Fidelity note: Claude Code enforces per-role tool limits (read-only gates, no-exec advisors) via
// tool permissions. Gemini's tool settings are session-wide, not per-command, so those limits are
// carried as explicit instructions in GEMINI.md and each role's prompt, with Gemini's own approval
// prompts / `--sandbox` doing the runtime enforcement. Same team, honestly mapped to Gemini.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));

export const meta = {
  id: "gemini",
  name: "Gemini CLI",
  agentsDir: ".gemini/commands/venom",
  settingsPath: ".gemini/settings.json",
  startHint:
    "Open this project in Gemini CLI and type `/venom:boss-1 <your goal>` to hand the wheel to the orchestrator — or just state your goal; GEMINI.md briefs Gemini as BOSS-1.",
  detect(targetDir) {
    return existsSync(join(targetDir, ".gemini")) || existsSync(join(targetDir, "GEMINI.md"));
  },
};

const VENOM_BEGIN = "<!-- VENOM:BEGIN";
const VENOM_END = "<!-- VENOM:END -->";

// Role names become path segments (.gemini/commands/venom/<role>.toml) and must be safe slugs, so a
// crafted pack or a tampered install.json can never traverse out of the managed directory.
const SAFE_ROLE = /^[a-z0-9][a-z0-9-]*$/;

// Sequences Gemini interprets at command-runtime inside a prompt: the TOML literal terminator ('''),
// shell injection (!{…}), file injection (@{…}), and argument substitution ({{…}}). A spec body must
// contain none of these, or embedding it into a slash command would be unsafe.
const GEMINI_UNSAFE = /'''|!\{|@\{|\{\{/;

function uniq(arr) {
  return [...new Set(arr)];
}

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function stripBom(s) {
  return s.replace(/^﻿/, "");
}

function copyIfAbsent(src, dest) {
  ensureDir(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyIfAbsent(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}

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

// Escape a value for a single-line TOML basic string (for `description`): backslash + quote escaped,
// and every control char (which would either break the line or make the TOML invalid) collapsed.
function tomlBasic(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f\x7f]+/g, " ").trim() + '"';
}

// Build the Markdown roster table from the roles catalog, one row per installed role.
function renderRoster(roles, catalog) {
  const rows = ["| Command | Role — what it does |", "|---------|---------------------|"];
  for (const r of roles) {
    const m = catalog[r] || {};
    const title = m.title || r;
    const summary = (m.summary || "").replace(/\|/g, "\\|");
    rows.push(`| \`/venom:${r}\` | ${title} — ${summary} |`);
  }
  return rows.join("\n");
}

// Render one Gemini custom-command TOML for a role. The prompt is a TOML *literal* multiline string
// ('''…'''), which does no escaping — so the body must contain none of Gemini's runtime directives.
// Throws (before any write) if it does, so an unsafe spec aborts the whole install cleanly.
function renderCommand(role, catalog, body) {
  const hit = body.match(GEMINI_UNSAFE);
  if (hit) {
    throw new Error(`spec for "${role}" contains a Gemini command directive (${hit[0]}) that can't be embedded safely into a slash command.`);
  }
  const m = catalog[role] || {};
  const description = `${m.title || role} — ${m.summary || ""}`.trim();
  const prompt = [
    body.trimEnd(),
    "",
    "---",
    "Before you act: read `CHARTER.md` (the project's constitution) and the relevant `agent-memory/` slices (`SNAPSHOT.md` first). When you finish a meaningful step, append a dated entry to `agent-memory/<team>/log.md` — that written trail is how the rest of the team sees your work.",
    "",
    "The owner's request: {{args}}",
  ].join("\n");
  return `description = ${tomlBasic(description)}\nprompt = '''\n${prompt}\n'''\n`;
}

/**
 * Install a Venom team into targetDir for Gemini CLI. Same option contract as every Venom adapter.
 * @returns {{roles:string[], agentsWritten:number, actions:object, warnings:string[], layout:object[]}}
 */
export function install(opts) {
  const {
    coreDir, targetDir, pack, charterContent,
    projectName = "This project", extraRoles = [], removeRoles = [],
    force = false, version = "0.0.0", now, preset = "",
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

  // Validate + render EVERY command into memory before touching the filesystem. Any bad role name,
  // missing spec, or unsafe body aborts here — nothing is written or deleted, so no partial install.
  const commands = new Map();
  for (const r of roles) {
    if (!SAFE_ROLE.test(r)) throw new Error(`unsafe role name "${r}" — role names must match ${SAFE_ROLE}`);
    if (!existsSync(join(coreDir, "agents", `${r}.md`))) throw new Error(`role "${r}" has no spec at core/agents/${r}.md`);
    if (!packs.roles[r]) throw new Error(`role "${r}" has no entry in the packs.json roles catalog`);
    commands.set(r, renderCommand(r, packs.roles, stripBom(readFileSync(join(coreDir, "agents", `${r}.md`), "utf8"))));
  }

  const commandsDir = join(targetDir, ".gemini", "commands", "venom");
  ensureDir(commandsDir);

  // Clean up commands a previous Venom install wrote but that this pack no longer includes.
  const installRecordPath = join(targetDir, ".venom", "install.json");
  if (existsSync(installRecordPath)) {
    try {
      const prev = JSON.parse(readFileSync(installRecordPath, "utf8"));
      for (const r of prev.managedAgents || []) {
        if (roles.includes(r)) continue;
        if (!SAFE_ROLE.test(r)) { warnings.push(`skipped cleanup of suspicious managed entry "${r}"`); continue; }
        const stale = join(commandsDir, `${r}.toml`);
        if (existsSync(stale)) rmSync(stale);
      }
    } catch {
      warnings.push("could not read previous .venom/install.json; skipped stale-command cleanup");
    }
  }

  // 1) One slash command per role: /venom:<role>.
  for (const [r, content] of commands) writeFileSync(join(commandsDir, `${r}.toml`), content);

  // 2) GEMINI.md — the team briefing Gemini auto-loads (managed block only).
  const tpl = readFileSync(join(ADAPTER_DIR, "GEMINI.template.md"), "utf8")
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{PACK_NAME\}\}/g, packs.packs[pack].name)
    .replace(/\{\{ROSTER\}\}/g, renderRoster(roles, packs.roles));
  const b = tpl.indexOf(VENOM_BEGIN);
  const e = tpl.indexOf(VENOM_END);
  const blockOnly = tpl.slice(b, e + VENOM_END.length);
  const geminiAction = writeManagedDoc(join(targetDir, "GEMINI.md"), tpl, blockOnly);

  // 3) Charter (never clobber unless forced).
  const charterPath = join(targetDir, "CHARTER.md");
  const charterExisted = existsSync(charterPath);
  let charterAction;
  if (!charterExisted || force) {
    writeFileSync(charterPath, charterContent.endsWith("\n") ? charterContent : charterContent + "\n");
    charterAction = charterExisted ? "overwritten" : "created";
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
    tool: "gemini",
    version,
    pack,
    preset,
    roles,
    extraRoles,
    removeRoles,
    managedAgents: roles,
    installedAt: now || new Date().toISOString(),
  };
  writeFileSync(installRecordPath, JSON.stringify(record, null, 2) + "\n");

  const layout = [
    { label: "team", path: "GEMINI.md", note: geminiAction },
    { label: "roles", path: ".gemini/commands/venom/", note: roles.map((r) => `/venom:${r}`).join(", ") },
    { label: "charter", path: "CHARTER.md", note: charterAction },
    { label: "memory", path: "agent-memory/", note: "" },
    { label: "guide", path: ".venom/workflow.md", note: "" },
  ];

  return {
    roles,
    agentsWritten: roles.length,
    actions: { geminiMd: geminiAction, charter: charterAction },
    warnings,
    layout,
  };
}

export default { meta, install };
