// venomkit CLI — `venom init` scaffolds a role-based agent team into a project.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { text, select, isInteractive } from "./prompts.js";
import { fillCharter } from "./charter.js";
import { loadAdapter, detectTool, ADAPTERS } from "./tool.js";
import { renderTokens } from "./tokens.js";
import { loadModels, resolvePreset, presetNames } from "./models.js";
import { loadBudgets, renderStats, renderCompact, renderIndex, searchMemory, readMemoryPath } from "./memory.js";
import { runMemoryServer, TOOLS as MCP_TOOLS } from "./mcp.js";
import { bold, dim, cyan, green, yellow, red } from "./style.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(PKG_ROOT, "core");

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const short: Record<string, string> = { y: "yes", h: "help", v: "version", d: "dir", p: "pack", n: "name", f: "force" };
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let key: string | null = null;
    if (a.startsWith("--")) key = a.slice(2);
    else if (a.startsWith("-") && a.length === 2) key = short[a[1]!] ?? a.slice(1);
    if (key === null) {
      args._.push(a);
      continue;
    }
    // Support the `--key=value` form so it can't be silently swallowed into the default.
    const eq = key.indexOf("=");
    if (eq !== -1) {
      const k = key.slice(0, eq);
      args[short[k] ?? k] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    const isBoolFlag = ["yes", "help", "version", "force", "write"].includes(key);
    if (isBoolFlag || next === undefined || next.startsWith("-")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPacks(): any {
  return JSON.parse(readFileSync(join(CORE, "packs.json"), "utf8"));
}

const HELP = `
${bold("Venom")} — scaffold a team of role-based AI agents into your project.

${bold("New here?")}  ${cyan("venom guide")}  — a plain-English walkthrough of the whole thing.

${bold("Usage")}
  venom guide [topic]       Walkthrough for new users (topic: start|memory|mcp|cli|cost)
  venom init [options]      Install a team into the current project
  venom list                Show the packs (sizes + the core roles) and add-ons
  venom add <role>          Add an optional role to an existing install
  venom tokens [--pack <id>]  Estimate the token footprint + cost across models
  venom models [preset]     Show or switch the model preset (quality/balanced/budget)
  venom memory <cmd>        Inspect, view & bound shared memory (stats|search|read|compact|index)
  venom mcp memory          Run the opt-in MCP memory server (agent calls tools at inference)
  venom mcp                 Show how to wire the MCP server into Claude Code / Codex / Gemini
  venom --version           Print the version
  venom --help              Show this help

${bold("init options")}
  --pack <id>               web-app | data-ml | research-academic | writing-content | security-audit | solo-minimal
  --roles <a,b,c>           Custom roster: pick specialists (the core gates are always installed)
  --name <name>             Project name (default: the folder name)
  --one-liner <text>        One-line description of the project
  --non-negotiables <text>  Rules that must never be broken (separate with ';')
  --out-of-lane <text>      What the project deliberately will not do
  --tool <id>               claude-code (default) | codex | gemini  (auto-detected if omitted)
  --models <preset>         quality | balanced (default) | budget  — cost/quality tradeoff
  --dir <path>              Target project directory (default: current)
  --force                   Overwrite an existing CHARTER.md
  --yes, -y                 Non-interactive: use flags + defaults, no prompts

${bold("memory commands")} ${dim("(operate on ./agent-memory, or pass --dir <project>)")}
  venom memory stats        Show the memory footprint — hot read-path vs. cold archives
  venom memory search <q>   Find matching entries (ranked); --limit <n>, --all (incl. archives)
  venom memory read <ref>   Print a file or a single entry, e.g. dev/log.md or dev/log.md#3
  venom memory compact      Archive old team-log entries (dry run; add --write to apply)
  venom memory index        Regenerate INDEX.md's entry catalog (preview; --write to save)
  --keep <n>                compact: entries to keep hot per log (default 20)
  --budget <tok>            compact: keep newest entries under this token budget instead
  --write                   compact/index: actually write (default is a safe dry run)

Works with Claude Code, Codex, and Gemini CLI.
`;

async function cmdInit(args: Args): Promise<void> {
  const targetDir = resolve(typeof args.dir === "string" ? args.dir : process.cwd());
  const packs = loadPacks();
  const packIds = Object.keys(packs.packs);

  // Resolve the tool: an explicit --tool wins; otherwise detect, and let the interactive user confirm.
  let toolId = typeof args.tool === "string" ? args.tool : detectTool(targetDir);
  const toolWasExplicit = typeof args.tool === "string";

  let pack = typeof args.pack === "string" ? args.pack : packs.defaultPack;
  let projectName = typeof args.name === "string" ? args.name : basename(targetDir);
  let oneLiner = typeof args["one-liner"] === "string" ? (args["one-liner"] as string) : "";
  let nonNegotiables = typeof args["non-negotiables"] === "string" ? (args["non-negotiables"] as string) : "";
  let outOfLane = typeof args["out-of-lane"] === "string" ? (args["out-of-lane"] as string) : "";
  // Custom roster: --roles picks the specialists (the core gates are always installed). A bare/empty
  // --roles is a mistake, not "install nothing" — reject it rather than silently ignoring.
  if (args.roles === true || args.roles === "") {
    console.error(red("--roles needs a comma-separated list, e.g. `--roles developer-1,testing,technical-writer`. Run `venom list` to see the roles."));
    process.exitCode = 1;
    return;
  }
  let rolesInput = typeof args.roles === "string" ? args.roles : "";

  console.log(bold("\n  Venom — let's set up your agent team.\n"));

  if (isInteractive() && !args.yes) {
    if (!toolWasExplicit) {
      toolId = await select(
        "Which coding tool are you using?",
        ADAPTERS.map((a) => ({ value: a.id, label: a.name + (a.id === toolId ? " (detected)" : "") })),
        Math.max(0, ADAPTERS.findIndex((a) => a.id === toolId)),
      );
    }
    pack = await select(
      "What kind of work is this?",
      packIds.map((id) => ({
        value: id,
        label: packs.packs[id].name + (id === packs.defaultPack ? " (default)" : ""),
        hint: packs.packs[id].bestFor,
      })),
      Math.max(0, packIds.indexOf(pack)),
    );
    if (!rolesInput) {
      const specialists = Object.keys(packs.roles).filter((r) => !packs.core.includes(r));
      console.log(dim(`\n  ${packs.packs[pack].name} installs: ${[...packs.core, ...packs.packs[pack].adds].join(", ")}`));
      console.log(dim(`  Core gates (always on): ${packs.core.join(", ")}`));
      console.log(dim(`  Pick your own specialists from: ${specialists.join(", ")}`));
      const custom = await text("Customize the roster? comma-separated specialists (or blank to use the pack)", "");
      if (custom.trim()) rolesInput = custom;
    }
    projectName = await text("Project name", projectName);
    oneLiner = await text("One-line description (what is this project?)", oneLiner);
    nonNegotiables = await text("Non-negotiables — rules that must never be broken (separate with ';')", nonNegotiables);
    outOfLane = await text("Out of scope — what this project deliberately won't do (optional)", outOfLane);
  }

  const adapterInfo = ADAPTERS.find((a) => a.id === toolId);
  if (!adapterInfo) {
    console.error(red(`Unknown tool "${toolId}". Available: ${ADAPTERS.map((a) => a.id).join(", ")}`));
    process.exitCode = 1;
    return;
  }
  if (adapterInfo.status !== "ready") {
    const ready = ADAPTERS.filter((a) => a.status === "ready").map((a) => a.id).join(", ");
    console.error(yellow(`The ${adapterInfo.name} adapter isn't ready yet. Available: ${ready}.`));
    process.exitCode = 1;
    return;
  }

  console.log(bold(`  Scaffolding your team for ${adapterInfo.name}.`));
  if (!toolWasExplicit && (!isInteractive() || Boolean(args.yes))) {
    console.log(dim("  (auto-selected — pass --tool claude-code|codex|gemini to choose a different one)"));
  }

  const recPath = join(targetDir, ".venom", "install.json");
  let priorExtraRoles: string[] = [];
  let priorRemoveRoles: string[] = [];
  let priorPreset = "";
  if (existsSync(recPath)) {
    console.log(dim("  Re-initializing — your existing CHARTER.md and agent-memory/ are preserved."));
    try {
      const prior = JSON.parse(readFileSync(recPath, "utf8"));
      // Carry forward roles the owner added (`venom add`) or removed, and the model preset.
      if (Array.isArray(prior.extraRoles)) priorExtraRoles = prior.extraRoles.filter((r: unknown) => typeof r === "string");
      if (Array.isArray(prior.removeRoles)) priorRemoveRoles = prior.removeRoles.filter((r: unknown) => typeof r === "string");
      if (typeof prior.preset === "string") priorPreset = prior.preset;
      if (prior.tool && prior.tool !== toolId) {
        const priorInfo = ADAPTERS.find((a) => a.id === prior.tool);
        console.log(
          yellow(`  ! Switching tool from ${priorInfo?.name ?? prior.tool} to ${adapterInfo.name}. The previous tool's files are left in place — remove them by hand if you don't want both installed.`),
        );
      }
    } catch {
      /* ignore an unreadable record */
    }
  }

  if (!packs.packs[pack]) {
    console.error(red(`Unknown pack "${pack}". Try: ${packIds.join(", ")}`));
    process.exitCode = 1;
    return;
  }

  // Resolve the roster. Default: carry forward prior add/remove (venom add). If --roles (or the
  // interactive prompt) was given, it REDEFINES the specialists on top of the always-on core gates —
  // expressed as extra/remove relative to the pack so the adapter's (core + adds + extra − remove) math
  // lands on exactly what the owner asked for.
  let extraRoles = priorExtraRoles;
  let removeRoles = priorRemoveRoles;
  const rosterGiven = rolesInput !== ""; // a value was passed (flag or interactive) — even if it's junk
  if (rosterGiven) {
    const requested = rolesInput.split(",").map((s) => s.trim()).filter(Boolean);
    const specialists = Object.keys(packs.roles).filter((r) => !packs.core.includes(r));
    const unknown = requested.filter((r) => !packs.roles[r]);
    if (unknown.length) {
      console.error(red(`Unknown role(s): ${unknown.join(", ")}.`));
      console.error(dim(`  Pick from: ${specialists.join(", ")}`));
      console.error(dim(`  (the core gates ${packs.core.join(", ")} are always included).`));
      process.exitCode = 1;
      return;
    }
    const desired = [...new Set(requested.filter((r) => !packs.core.includes(r)))]; // core is always on
    if (desired.length === 0) {
      // No specialists (empty, only-commas, or only core roles) — a gate-only team isn't useful, and this
      // is almost always a mistake. Reject consistently (bare/empty --roles is already rejected above).
      console.error(red(`--roles must name at least one specialist. The core gates (${packs.core.join(", ")}) are always installed.`));
      console.error(dim(`  Specialists: ${specialists.join(", ")}`));
      process.exitCode = 1;
      return;
    }
    const packAdds: string[] = packs.packs[pack].adds;
    extraRoles = desired.filter((r) => !packAdds.includes(r));
    removeRoles = packAdds.filter((r) => !desired.includes(r));
    console.log(dim(`  Custom roster: ${[...packs.core, ...desired].join(", ")}  (${packs.core.length + desired.length} agents)`));
  }

  // Resolve the model preset (flag > carried-forward > default).
  const modelsCfg = loadModels(CORE);
  const presetName = typeof args.models === "string" ? args.models : priorPreset || modelsCfg.defaultPreset;
  let plan;
  try {
    plan = resolvePreset(CORE, Object.keys(packs.roles), toolId, presetName);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
    return;
  }

  const template = readFileSync(join(CORE, "CHARTER_TEMPLATE.md"), "utf8");
  const charterContent = fillCharter(template, { projectName, oneLiner, nonNegotiables, outOfLane });

  const adapter = await loadAdapter(PKG_ROOT, toolId);
  const res = adapter.install({
    coreDir: CORE,
    targetDir,
    pack,
    charterContent,
    projectName,
    version: readVersion(),
    force: Boolean(args.force),
    extraRoles,
    removeRoles,
    modelByRole: plan.modelByRole,
    preset: plan.preset,
  });

  const teamLabel = rosterGiven ? "custom roster" : `${packs.packs[pack].name} team`;
  console.log(green(`\n  ✓ Installed the ${bold(teamLabel)} — ${res.agentsWritten} agents for ${adapterInfo.name}.\n`));
  const layout: Array<{ label: string; path: string; note?: string }> = Array.isArray(res.layout) ? res.layout : [];
  for (const item of layout) {
    const note = item.note ? dim(`  ${item.note}`) : "";
    console.log(`  ${dim(item.label.padEnd(8))} ${item.path}${note}`);
  }
  const modelNote = plan.perRole
    ? dim("  · applied per role")
    : dim(`  · advisory: run ${adapterInfo.name} with ${plan.sessionModel} (it uses one model per session)`);
  console.log(`  ${dim("models".padEnd(8))} ${plan.preset} preset${modelNote}`);
  for (const w of res.warnings) console.log(yellow(`  ! ${w}`));

  console.log(bold("\n  Next:"));
  console.log(`  ${dim("New to Venom?")}  Run ${cyan("venom guide")} ${dim("for a plain-English walkthrough of everything below.")}`);
  console.log(`  1. Review ${cyan("CHARTER.md")} — sharpen the non-negotiables and scope. It drives every decision.`);
  console.log(`  2. Read ${cyan(".venom/workflow.md")} — how to drive your team (the leash, the gates, the loops).`);
  const startHint = adapter.meta.startHint ?? `Open this project in ${adapterInfo.name} and give BOSS-1 your first goal.`;
  console.log(`  3. ${startHint}`);
  console.log(`  4. ${dim("Optional: run")} ${cyan("venom mcp")} ${dim("to wire the opt-in memory server so agents")}`);
  console.log(dim("     fetch/append memory with a tool call at inference instead of reading whole files.\n"));
}

function cmdList(): void {
  const packs = loadPacks();
  console.log(bold("\n  Venom packs\n"));
  for (const id of Object.keys(packs.packs)) {
    const pk = packs.packs[id];
    const size = packs.core.length + pk.adds.length;
    console.log(`  ${bold(id)}${id === packs.defaultPack ? dim(" (default)") : ""}  ${dim(`· ${size} agents`)}`);
    console.log(`    ${pk.description}`);
    console.log(`    ${dim("best for: " + pk.bestFor)}\n`);
  }
  console.log(dim(`  core (every pack): ${packs.core.join(", ")}`));
  console.log(dim(`  optional add-ons: marketing   →  venom add <role>\n`));
}

function cmdTokens(args: Args): void {
  const packs = loadPacks();
  const pack = typeof args.pack === "string" ? args.pack : packs.defaultPack;
  if (!packs.packs[pack]) {
    console.error(red(`Unknown pack "${pack}". Try: ${Object.keys(packs.packs).join(", ")}`));
    process.exitCode = 1;
    return;
  }
  console.log(renderTokens(CORE, packs, pack));
}

async function cmdModels(args: Args): Promise<void> {
  const targetDir = resolve(typeof args.dir === "string" ? args.dir : process.cwd());
  const packs = loadPacks();
  const modelsCfg = loadModels(CORE);
  const preset = args._[1];

  if (!preset) {
    console.log(bold("\n  Model presets\n"));
    for (const name of presetNames(CORE)) {
      console.log(`  ${bold(name)}${name === modelsCfg.defaultPreset ? dim(" (default)") : ""}  ${dim(modelsCfg.presetSummary[name] ?? "")}`);
    }
    console.log(dim("\n  Apply:  venom models <preset>    ·    compare costs:  venom tokens\n"));
    return;
  }

  const recPath = join(targetDir, ".venom", "install.json");
  if (!existsSync(recPath)) {
    console.error(red("No Venom install found here. Run `venom init` first."));
    process.exitCode = 1;
    return;
  }
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  const toolId = typeof rec.tool === "string" ? rec.tool : "claude-code";
  let plan;
  try {
    plan = resolvePreset(CORE, Object.keys(packs.roles), toolId, preset);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
    return;
  }

  const charterPath = join(targetDir, "CHARTER.md");
  const charterContent = existsSync(charterPath) ? readFileSync(charterPath, "utf8") : "";
  const adapter = await loadAdapter(PKG_ROOT, toolId);
  adapter.install({
    coreDir: CORE,
    targetDir,
    pack: rec.pack,
    charterContent,
    version: readVersion(),
    extraRoles: rec.extraRoles ?? [],
    removeRoles: rec.removeRoles ?? [],
    modelByRole: plan.modelByRole,
    preset: plan.preset,
  });

  const info = ADAPTERS.find((a) => a.id === toolId);
  if (plan.perRole) {
    console.log(green(`  ✓ Applied the ${bold(preset)} model preset — per-role models updated in .claude/agents/.`));
  } else {
    console.log(green(`  ✓ Recorded the ${bold(preset)} preset.`) + dim(` ${info?.name ?? toolId} uses one model per session — run it with ${plan.sessionModel}.`));
  }
}

function cmdMemory(args: Args): void {
  const targetDir = resolve(typeof args.dir === "string" ? args.dir : process.cwd());
  const memDir = join(targetDir, "agent-memory");
  if (!existsSync(memDir)) {
    console.error(red(`No agent-memory/ found in ${targetDir}. Run \`venom init\` first, or pass --dir <project>.`));
    process.exitCode = 1;
    return;
  }
  const sub = args._[1] ?? "stats";
  const budgets = loadBudgets(CORE);
  const write = Boolean(args.write);

  if (sub === "stats") {
    console.log(renderStats(memDir, budgets));
    return;
  }
  if (sub === "compact") {
    // A dash-prefixed, missing (`--keep`), or empty (`--keep=`) value must not be silently reinterpreted
    // — bare/dashed parses to boolean true; empty parses to "" which Number()s to a surprising 0.
    if (args.keep === true || args.budget === true || args.keep === "" || args.budget === "") {
      console.error(red("--keep and --budget each need a numeric value, e.g. `--keep 20` or `--budget 2500`."));
      process.exitCode = 1;
      return;
    }
    const keep = typeof args.keep === "string" ? Number(args.keep) : undefined;
    const budgetTok = typeof args.budget === "string" ? Number(args.budget) : undefined;
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 0)) {
      console.error(red("--keep must be a non-negative integer."));
      process.exitCode = 1;
      return;
    }
    if (budgetTok !== undefined && (!Number.isFinite(budgetTok) || budgetTok <= 0)) {
      console.error(red("--budget must be a positive number of tokens."));
      process.exitCode = 1;
      return;
    }
    if (keep !== undefined && budgetTok !== undefined) {
      console.log(dim("  Note: both --keep and --budget given; using --budget."));
    }
    console.log(renderCompact(memDir, { keep, budgetTok }, write, budgets));
    return;
  }
  if (sub === "index") {
    console.log(renderIndex(memDir, write));
    return;
  }
  if (sub === "search") {
    const query = args._.slice(2).join(" ").trim();
    if (!query) {
      console.error(red("Usage: venom memory search <query> [--limit <n>] [--all]"));
      process.exitCode = 1;
      return;
    }
    // A bare/dashed `--limit` parses to boolean true; `--limit=` parses to "". Reject both rather than
    // silently falling back to the default — the same guard compact's --keep already enforces.
    if (args.limit === true || args.limit === "") {
      console.error(red("--limit needs a numeric value, e.g. `--limit 5`."));
      process.exitCode = 1;
      return;
    }
    const limit = typeof args.limit === "string" ? Number(args.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      console.error(red("--limit must be a positive integer."));
      process.exitCode = 1;
      return;
    }
    const hits = searchMemory(memDir, query, { limit, includeArchived: Boolean(args.all || args.archived) });
    console.log(renderSearch(query, hits));
    return;
  }
  if (sub === "read") {
    const path = typeof args._[2] === "string" ? args._[2] : "";
    if (!path.trim()) {
      console.error(red("Usage: venom memory read <path>   e.g. `venom memory read SNAPSHOT.md` or `venom memory read dev/log.md#3`"));
      process.exitCode = 1;
      return;
    }
    try {
      const r = readMemoryPath(memDir, path);
      console.log(`\n${bold("  " + r.ref)}\n\n${r.text}\n`);
    } catch (err) {
      console.error(red(`venom: ${err instanceof Error ? err.message : String(err)}`));
      process.exitCode = 1;
    }
    return;
  }
  console.error(red(`Unknown memory subcommand "${sub}". Use: stats | search | read | compact | index.`));
  process.exitCode = 1;
}

function renderSearch(query: string, hits: ReturnType<typeof searchMemory>): string {
  const L: string[] = [""];
  if (hits.length === 0) {
    L.push(dim(`  No memory matched "${query}". Try broader keywords, or add --all to include cold archives.`));
    L.push("");
    return L.join("\n");
  }
  L.push(bold(`  ${hits.length} result${hits.length === 1 ? "" : "s"} for "${query}"`) + dim("  — most relevant first"));
  L.push(dim("  Read a full entry with:  ") + cyan("venom memory read <ref>"));
  L.push("");
  hits.forEach((h, i) => {
    L.push(`  ${dim((i + 1 + ".").padStart(3))} ${cyan(h.ref)}  ${dim("[" + h.field + "]")}`);
    L.push(`      ${h.snippet}`);
  });
  L.push("");
  return L.join("\n");
}

// Clip a tool description to a short one-liner at a word boundary — never mid-abbreviation (the old
// split-on-"." mangled "e.g." and "vs." into "e" / "vs").
function clipClause(s: string, max = 78): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut) + "…";
}

function printMcpWiring(targetDir: string): void {
  const inProject = existsSync(join(targetDir, ".venom", "install.json"));
  console.log(bold("\n  Venom memory — opt-in MCP server\n"));
  console.log("  Lets your agent fetch the right memory slice (or write one) with a tool call at");
  console.log("  inference, instead of reading whole files. Tools it exposes:");
  for (const t of MCP_TOOLS) console.log(`    ${cyan(t.name.padEnd(16))} ${dim(clipClause(t.description))}`);
  console.log(dim("\n  The server reads/writes this project's agent-memory/. Add it to your tool once:\n"));

  console.log(bold("  Claude Code") + dim("  — writes .mcp.json in the repo, so teammates get it too:"));
  console.log("    claude mcp add --scope project venom-memory -- npx -y venomkit mcp memory");
  console.log(bold("\n  Codex") + dim("  — ~/.codex/config.toml is global, so pin it to THIS project with --dir:"));
  console.log(`    [mcp_servers.venom-memory]\n    command = "npx"\n    args = ["-y", "venomkit", "mcp", "memory", "--dir", ${JSON.stringify(targetDir)}]`);
  console.log(bold("\n  Gemini CLI") + dim("  — .gemini/settings.json:"));
  console.log('    { "mcpServers": { "venom-memory": { "command": "npx", "args": ["-y", "venomkit", "mcp", "memory"] } } }');
  console.log(dim("\n  Launch it from the project root so it targets this project's memory (or pass --dir <path>)."));
  console.log(dim("  Writes are lock-serialized for agents on ONE machine; sharing agent-memory/ across hosts"));
  console.log(dim("  assumes each host has a unique hostname. Appends mutate shared files under agent-memory/."));
  if (!inProject) console.log(yellow("\n  ! No Venom install detected here — run `venom init` first so there's an agent-memory/ to serve."));
  console.log("");
}

function cmdMcp(args: Args): void {
  const targetDir = resolve(typeof args.dir === "string" ? args.dir : process.cwd());
  const sub = args._[1];
  if (sub === "memory") {
    const memDir = join(targetDir, "agent-memory");
    if (!existsSync(memDir)) {
      console.error(red(`No agent-memory/ found in ${targetDir}. Run \`venom init\` first, or pass --dir <project>.`));
      process.exitCode = 1;
      return;
    }
    // Runs until stdin closes; must not write anything but JSON-RPC to stdout.
    runMemoryServer({ memDir, coreDir: CORE, version: readVersion(), now: () => new Date() });
    return;
  }
  if (sub === undefined) {
    printMcpWiring(targetDir);
    return;
  }
  console.error(red(`Unknown mcp subcommand "${sub}". Use: venom mcp memory  (run the server)  ·  venom mcp  (wiring help).`));
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// guide — a friendly, in-terminal walkthrough for someone brand new to Venom.
// ---------------------------------------------------------------------------

const GUIDE_TOPICS = ["start", "memory", "mcp", "cli", "cost"] as const;
type GuideTopic = (typeof GUIDE_TOPICS)[number];

function guideOverview(): string {
  return [
    "",
    bold("  Venom — how it works, in 60 seconds"),
    "",
    "  Venom drops a team of role-based AI agents into your project. You talk to " + bold("BOSS-1") + ", the",
    "  orchestrator. It breaks your goal into tasks, hands each to the right specialist, runs a review",
    "  loop, and records everything to a shared on-disk memory — so the team stays coordinated and",
    "  remembers across sessions.",
    "",
    "  " + bold("The loop:") + "  you give BOSS-1 a goal  →  it delegates to specialists  →  " + dim("critics + security"),
    "  " + dim("gates review and can BLOCK")  + "  →  the work and the decisions land in agent-memory/.",
    "",
    "  " + bold("Four steps to start:"),
    "    1. " + cyan("venom init") + dim("          install a team into your project"),
    "    2. edit " + cyan("CHARTER.md") + dim("      the scope + rules every agent reads first"),
    "    3. open the project in your coding tool and give BOSS-1 a goal in plain English",
    "    4. " + cyan("venom memory stats") + dim("  keep the shared memory lean as the project grows"),
    "",
    "  " + bold("Read more:") + "  " + cyan("venom guide " + GUIDE_TOPICS.join(" | ")),
    "",
  ].join("\n");
}

function guideStart(): string {
  return [
    bold("  ▸ start — from zero to your first goal"),
    "",
    dim("  (Commands below are written as `venom …`. Without a global install, prefix them with"),
    dim("   `npx venomkit` — e.g. `npx venomkit memory stats`.)"),
    "",
    "  1. Install a team " + dim("(inside your project folder — safe on an existing repo):"),
    "       " + cyan("npx venomkit init") + dim("                         interactive"),
    "       " + cyan("npx venomkit init --pack solo-minimal --yes") + dim("  scripted"),
    dim("     Pick a pack with `venom list` (solo-minimal = lightest; web-app = the full org),"),
    dim("     or build a custom roster: ") + cyan("--roles developer-1,testing") + dim(" (core gates always on)."),
    "",
    "  2. Sharpen " + cyan("CHARTER.md") + " — the single source of truth every agent reads before acting.",
    dim("     Fill in the real scope and the non-negotiables (the rules that must never be broken)."),
    "",
    "  3. Drive the team. Open the project in Claude Code / Codex / Gemini — your lead session IS",
    "     BOSS-1. Just give it a goal:",
    green("       \"Add JWT auth — signup, login, protected routes. Tests required.\""),
    dim("     BOSS-1 plans it, delegates to the specialists, runs the gates, and logs every step."),
    dim("     Read .venom/workflow.md once — it explains the leash, the gates, and the loops."),
    "",
  ].join("\n");
}

function guideMemory(): string {
  return [
    bold("  ▸ memory — the shared brain (agent-memory/)"),
    "",
    "  Everything the team knows lives in " + cyan("agent-memory/") + ". Layout:",
    dim("     SNAPSHOT.md          where the project is right now (read first, kept small)"),
    dim("     INDEX.md             a scannable catalog of every log entry"),
    dim("     <team>/log.md        append-only record of every action (dev/research/review/security)"),
    dim("     <team>/log.archive.md old entries moved here by compaction (never deleted)"),
    dim("     lessons/<team>.md    rules learned from mistakes (compounds over time)"),
    dim("     adr/<team>/          load-bearing decisions (immutable)"),
    dim("     decisions/needed.md  the escalation queue"),
    "",
    "  " + bold("View it from the CLI") + dim("  (no MCP needed):"),
    "     " + cyan("venom memory stats") + dim("            where the tokens are — hot read-path vs. cold archives"),
    "     " + cyan("venom memory search <query>") + dim("   find the entries that match (ranked)"),
    "     " + cyan("venom memory read <ref>") + dim("       print a file or a single entry, e.g. dev/log.md#3"),
    "     " + cyan("venom memory index") + dim("            regenerate INDEX.md's catalog"),
    "",
    "  " + bold("Keep it lean as it grows:"),
    "     " + cyan("venom memory compact --write") + dim("   archive old log entries (verbatim; nothing is lost)"),
    dim("     Hot path (SNAPSHOT + a log slice) stays small so agents read little each turn."),
    "",
  ].join("\n");
}

function guideMcp(): string {
  return [
    bold("  ▸ mcp — let the agent read/write memory at inference (optional)"),
    "",
    "  The CLI viewers above are for " + bold("you") + ". The MCP server is for the " + bold("agent") + " — it exposes",
    "  memory as tools the agent calls mid-task, so it fetches the exact slice it needs instead of",
    "  reading whole files. It's opt-in; nothing runs unless you wire it.",
    "",
    "     " + cyan("venom mcp") + dim("           print the one-line wiring for Claude Code / Codex / Gemini"),
    "     " + cyan("venom mcp memory") + dim("    the server itself (your tool launches this; you rarely run it by hand)"),
    "",
    "  Tools the agent gets: " + dim("memory_search, memory_read, memory_append, memory_stats, memory_compact."),
    dim("  Zero-dependency, path-contained to agent-memory/, and writes are lock-serialized."),
    "",
  ].join("\n");
}

function guideCli(): string {
  return [
    bold("  ▸ cli — the full command map"),
    "",
    "     " + cyan("venom init") + dim("               install a team into the current project"),
    "     " + cyan("venom list") + dim("               show the 6 packs (sizes + the core roles)"),
    "     " + cyan("venom add <role>") + dim("         add an optional role to an install"),
    "     " + cyan("venom guide [topic]") + dim("      this walkthrough (topic: " + GUIDE_TOPICS.join(" | ") + ")"),
    "     " + cyan("venom tokens") + dim("             token footprint + cost across models/presets"),
    "     " + cyan("venom models [preset]") + dim("    show or switch the model preset"),
    "     " + cyan("venom memory <cmd>") + dim("       stats | search | read | compact | index"),
    "     " + cyan("venom mcp [memory]") + dim("       wiring help, or run the opt-in memory server"),
    "     " + cyan("venom --help") + dim("             the terse reference  ·  ") + cyan("venom --version"),
    "",
    dim("     Most commands take --dir <path> to target a project other than the current folder."),
    "",
  ].join("\n");
}

function guideCost(): string {
  return [
    bold("  ▸ cost — control what you spend"),
    "",
    "     " + cyan("venom tokens") + dim("             per-turn / per-goal footprint + $/goal for each preset"),
    "     " + cyan("venom models budget") + dim("      switch the whole team to the cheapest tier (rewrites each role)"),
    "",
    "  Three presets: " + bold("quality") + " · " + bold("balanced") + dim(" (default)") + " · " + bold("budget") + ".",
    dim("     budget drops the heads + workers to Haiku-class and the bosses + review gates from Opus to Sonnet."),
    dim("     On Claude Code this rewrites each agent's model per-role; on Codex/Gemini it's an advisory."),
    dim("     Compaction (see `venom guide memory`) is the other lever — it bounds what agents read."),
    "",
  ].join("\n");
}

const GUIDE_SECTIONS: Record<GuideTopic, () => string> = {
  start: guideStart,
  memory: guideMemory,
  mcp: guideMcp,
  cli: guideCli,
  cost: guideCost,
};

function cmdGuide(args: Args): void {
  const topic = typeof args._[1] === "string" ? args._[1].toLowerCase() : "";
  if (topic && !(GUIDE_TOPICS as readonly string[]).includes(topic)) {
    console.error(red(`Unknown guide topic "${topic}". Try: ${GUIDE_TOPICS.join(" | ")}  (or just \`venom guide\`).`));
    process.exitCode = 1;
    return;
  }
  if (topic) {
    console.log("\n" + GUIDE_SECTIONS[topic as GuideTopic]());
    return;
  }
  // No topic: the whole walkthrough, overview first.
  console.log(guideOverview());
  for (const t of GUIDE_TOPICS) console.log(GUIDE_SECTIONS[t]());
  console.log(dim("  Tip: `venom guide <topic>` prints just one section.\n"));
}

async function cmdAdd(args: Args): Promise<void> {
  const targetDir = resolve(typeof args.dir === "string" ? args.dir : process.cwd());
  const role = args._[1];
  if (!role) {
    console.error(red("Usage: venom add <role>"));
    process.exitCode = 1;
    return;
  }
  const packs = loadPacks();
  if (!packs.roles[role]) {
    console.error(red(`Unknown role "${role}". Known roles: ${Object.keys(packs.roles).join(", ")}`));
    process.exitCode = 1;
    return;
  }
  const recPath = join(targetDir, ".venom", "install.json");
  if (!existsSync(recPath)) {
    console.error(red("No Venom install found here. Run `venom init` first."));
    process.exitCode = 1;
    return;
  }
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  const charterPath = join(targetDir, "CHARTER.md");
  const charterContent = existsSync(charterPath) ? readFileSync(charterPath, "utf8") : "";
  const tool = rec.tool ?? "claude-code";
  const adapter = await loadAdapter(PKG_ROOT, tool);
  const extraRoles = Array.from(new Set([...(rec.extraRoles ?? []), role]));
  // Preserve the custom roster: a `--roles` install persists removeRoles; if we dropped it the adapter
  // would re-inflate the whole pack. Un-remove the role we're adding (it may have been a removed pack add).
  const removeRoles = (Array.isArray(rec.removeRoles) ? rec.removeRoles : []).filter((r: string) => r !== role);
  // Preserve the model preset the owner chose — otherwise every agent re-renders at the default model.
  const modelsCfg = loadModels(CORE);
  const presetName = typeof rec.preset === "string" && modelsCfg.presets[rec.preset] ? rec.preset : modelsCfg.defaultPreset;
  const plan = resolvePreset(CORE, Object.keys(packs.roles), tool, presetName);
  const res = adapter.install({
    coreDir: CORE,
    targetDir,
    pack: rec.pack,
    charterContent,
    version: readVersion(),
    extraRoles,
    removeRoles,
    modelByRole: plan.modelByRole,
    preset: plan.preset,
  });
  if (res.roles.includes(role)) {
    console.log(green(`  ✓ Added ${bold(role)}. Team now has ${res.agentsWritten} agents.`));
  } else {
    console.error(red(`  Could not add "${role}".`));
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(readVersion());
    return;
  }
  const hasSubcommand = args._[0] !== undefined;
  const cmd = args._[0] ?? "init";
  if (args.help || cmd === "help") {
    console.log(HELP);
    return;
  }
  // Bare `venom` (no subcommand) is a friendly interactive `init` in a real terminal. But in a
  // non-interactive context (piped, CI, some `npx` wrappers) that would scaffold a whole team into the
  // cwd with no confirmation — so show help instead. An explicit `venom init` (e.g. with --yes) still runs.
  if (!hasSubcommand && !process.stdin.isTTY) {
    console.log(HELP);
    return;
  }
  if (cmd === "guide") return cmdGuide(args);
  if (cmd === "init") return cmdInit(args);
  if (cmd === "list") return cmdList();
  if (cmd === "add") return cmdAdd(args);
  if (cmd === "tokens") return cmdTokens(args);
  if (cmd === "models") return cmdModels(args);
  if (cmd === "memory") return cmdMemory(args);
  if (cmd === "mcp") return cmdMcp(args);
  console.error(red(`Unknown command "${cmd}".`));
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(red("venom: " + msg));
  process.exitCode = 1;
});
