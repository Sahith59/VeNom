// venomkit CLI — `venom init` scaffolds a role-based agent team into a project.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { text, select, isInteractive } from "./prompts.js";
import { fillCharter } from "./charter.js";
import { loadAdapter, detectTool, ADAPTERS } from "./tool.js";
import { renderTokens } from "./tokens.js";
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
    const next = argv[i + 1];
    const isBoolFlag = ["yes", "help", "version", "force"].includes(key);
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

${bold("Usage")}
  venom init [options]      Install a team into the current project
  venom list                Show the available packs and roles
  venom add <role>          Add an optional role to an existing install
  venom tokens [--pack <id>]  Estimate the token footprint + cost across models
  venom --version           Print the version
  venom --help              Show this help

${bold("init options")}
  --pack <id>               web-app | data-ml | research-academic | writing-content | security-audit | solo-minimal
  --name <name>             Project name (default: the folder name)
  --one-liner <text>        One-line description of the project
  --non-negotiables <text>  Rules that must never be broken (separate with ';')
  --out-of-lane <text>      What the project deliberately will not do
  --tool <id>               claude-code (default) | codex | gemini  (auto-detected if omitted)
  --dir <path>              Target project directory (default: current)
  --force                   Overwrite an existing CHARTER.md
  --yes, -y                 Non-interactive: use flags + defaults, no prompts

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
  if (existsSync(recPath)) {
    console.log(dim("  Re-initializing — your existing CHARTER.md and agent-memory/ are preserved."));
    try {
      const prior = JSON.parse(readFileSync(recPath, "utf8"));
      // Carry forward roles the owner added (`venom add`) or removed, so re-init doesn't drop them.
      if (Array.isArray(prior.extraRoles)) priorExtraRoles = prior.extraRoles.filter((r: unknown) => typeof r === "string");
      if (Array.isArray(prior.removeRoles)) priorRemoveRoles = prior.removeRoles.filter((r: unknown) => typeof r === "string");
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
    extraRoles: priorExtraRoles,
    removeRoles: priorRemoveRoles,
  });

  console.log(green(`\n  ✓ Installed the ${bold(packs.packs[pack].name)} team — ${res.agentsWritten} agents for ${adapterInfo.name}.\n`));
  const layout: Array<{ label: string; path: string; note?: string }> = Array.isArray(res.layout) ? res.layout : [];
  for (const item of layout) {
    const note = item.note ? dim(`  ${item.note}`) : "";
    console.log(`  ${dim(item.label.padEnd(8))} ${item.path}${note}`);
  }
  for (const w of res.warnings) console.log(yellow(`  ! ${w}`));

  console.log(bold("\n  Next:"));
  console.log(`  1. Review ${cyan("CHARTER.md")} — sharpen the non-negotiables and scope. It drives every decision.`);
  console.log(`  2. Read ${cyan(".venom/workflow.md")} — how to drive your team (the leash, the gates, the loops).`);
  const startHint = adapter.meta.startHint ?? `Open this project in ${adapterInfo.name} and give BOSS-1 your first goal.`;
  console.log(`  3. ${startHint}\n`);
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
  const adapter = await loadAdapter(PKG_ROOT, rec.tool ?? "claude-code");
  const extraRoles = Array.from(new Set([...(rec.extraRoles ?? []), role]));
  const res = adapter.install({
    coreDir: CORE,
    targetDir,
    pack: rec.pack,
    charterContent,
    version: readVersion(),
    extraRoles,
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
  const cmd = args._[0] ?? "init";
  if (args.help || cmd === "help") {
    console.log(HELP);
    return;
  }
  if (cmd === "init") return cmdInit(args);
  if (cmd === "list") return cmdList();
  if (cmd === "add") return cmdAdd(args);
  if (cmd === "tokens") return cmdTokens(args);
  console.error(red(`Unknown command "${cmd}".`));
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(red("venom: " + msg));
  process.exitCode = 1;
});
