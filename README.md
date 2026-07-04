# Venom

**Give any coding-agent user a whole company of specialists instead of one generalist.**

Venom scaffolds a named team of role-based AI agents — a boss, researchers, developers, reviewers, a
security auditor — with shared, persistent memory, into any project. One command drops the team in;
you drive it through your coding agent.

[![npm](https://img.shields.io/npm/v/venomkit.svg)](https://www.npmjs.com/package/venomkit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)

---

## The honest pitch

A single coding agent is **one generalist**: it forgets between sessions, reviews its own work, and
holds one perspective.

Venom gives you a **team**: specialized roles, independent review gates a generalist skips, and a
memory that persists across sessions and survives context resets. So you **catch more, forget less,
and work with more rigor.**

That's the whole claim. No "10x", no magic — just structure a solo agent doesn't have. The honesty is
the point: it's why you can trust the parts Venom *does* do.

## Quickstart

```bash
cd your-project
npx venomkit init
```

`init` asks **which coding tool you use** (Claude Code, Codex, or Gemini) and what kind of work you
do, fills a project **Charter**, writes the memory scaffold, and installs the agents where that tool
looks for them — in under a minute, no config editing. Then open the project in that tool and give
**boss-1** your first goal.

Prefer non-interactive? Name the tool and pack directly:

```bash
npx venomkit init --tool codex --pack web-app --yes   # or --tool gemini / claude-code
```

> **Requirements:** a coding agent you already use — **[Claude Code](https://claude.com/claude-code)**,
> **[Codex](https://github.com/openai/codex)**, or **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** —
> and **Node.js ≥ 18.17**. Venom is for developers comfortable in a terminal; it doesn't try to be a
> no-terminal GUI.

```mermaid
flowchart LR
    A(["npx venomkit init"]) --> B["detect your<br/>coding tool"] --> C["pick a pack"] --> D["3-4 plain<br/>questions"] --> E["fill CHARTER.md"] --> F["install the team"] --> G([" ready in under a minute "])
```

## What gets installed

```
your-project/
├── CHARTER.md            # your project's constitution — identity, non-negotiables, scope (yours to edit)
├── CLAUDE.md             # briefs your lead session to operate as boss-1, and loads the Charter
├── .claude/
│   ├── agents/           # your team, as individual agent files
│   └── settings.json     # safe permissions (allow reads · ask before impact · deny danger)
├── agent-memory/         # the team's shared, persistent memory (SNAPSHOT, logs, lessons, ADRs)
└── .venom/
    ├── workflow.md       # your guide to driving the team
    └── install.json      # install record (pack, roles, version) — used by re-init and `add`
```

Nothing is clobbered on re-run: your `CHARTER.md`, your own notes in `CLAUDE.md`, your existing
`settings.json` rules, and your live `agent-memory/` are all preserved.

> That's the **Claude Code** layout. `--tool codex` installs the same team as an `AGENTS.md` brief
> plus `.venom/agents/` role specs; `--tool gemini` installs it as `GEMINI.md` plus `/venom:<role>`
> slash-commands under `.gemini/commands/`. Same core, same memory — mapped to each tool's native shape.

## The two ideas that make it a team (not a pile of prompts)

1. **Shared, persistent memory.** Agents don't chat live — they coordinate through files under
   `agent-memory/`, read before acting and written after. One agent's result becomes the next agent's
   starting point, and it all survives a context reset. Governing rule: *write everything, read
   selectively.*
2. **Two independent review gates.** Before anything is called done, it passes **critics**
   (correctness + your Charter's non-negotiables) and **security** (exploitability) — both read-only,
   both must pass. They flag and block; they never fix. You make the final call.

## Packs — pick the team that fits your work

Every pack ships the same core four (`boss-1`, `boss-2`, `critics`, `security`) plus the full memory
tier. They differ only in the specialists:

```mermaid
flowchart TD
    CORE["🧩 Core — in every pack<br/>boss-1 · boss-2 · critics · security<br/>+ shared persistent memory"]
    CORE --> P1["web-app · 14<br/>full software team"]
    CORE --> P2["data-ml · 12<br/>data + models"]
    CORE --> P3["research-academic · 10<br/>advisory research room"]
    CORE --> P4["writing-content · 9<br/>writing room"]
    CORE --> P5["security-audit · 8<br/>threat modeling + audit"]
    CORE --> P6["solo-minimal · 8<br/>lightest team"]
```

| Pack | Agents | Best for |
|------|:------:|----------|
| **web-app** _(default)_ | 14 | Web apps, APIs, CLIs, general software |
| **data-ml** | 12 | Data pipelines, ETL, model training & evaluation |
| **research-academic** | 10 | Literature reviews, study design, rigorous written research |
| **writing-content** | 9 | Articles and docs where the claims must hold up |
| **security-audit** | 8 | Security reviews and audits of an existing codebase |
| **solo-minimal** | 8 | A solo dev who wants review + memory without the full org |

```bash
npx venomkit list            # see the packs and roles
npx venomkit init --pack solo-minimal
```

## How you drive the team

You talk to **boss-1** — one point of contact, not the whole roster. You give it a goal and set the
**leash** (how much autonomy to take); it decomposes the goal, delegates to the right specialists,
runs the review gates, and brings back **one reconciled recommendation**. You approve what matters.

The full daily-use guide — the leash, the gates, the quality loops, a troubleshooting table, and what
to expect — is installed at **`.venom/workflow.md`**.

Behind that one conversation, the whole team is at work:

```mermaid
flowchart TD
    You["👤 You — the owner"]
    You -->|"goal + the leash (how much autonomy)"| B1["boss-1<br/>orchestrator"]
    B1 -->|"one reconciled recommendation"| You
    B1 <-->|"audits the big calls"| B2["boss-2<br/>independent auditor"]
    B1 --> RH["research-head"]
    B1 --> DH["dev-head"]
    RH --> RES["researchers"]
    DH --> BLD["developers · testing<br/>debugger · design · docs"]
    BLD -->|"finished work"| CR["critics<br/>correctness + trust"]
    BLD -->|"finished work"| SE["security<br/>exploitability"]
    CR -->|"BLOCK → back to build"| DH
    SE -->|"BLOCK → back to build"| DH
    CR -->|"PASS"| B1
    SE -->|"PASS"| B1
```

Only the bosses talk to you; the gates and boss-2 report to boss-1 directly. **Both gates must be
green before anything ships** — and you make the final call.

## What Venom is NOT (so you can trust what it is)

- **Not an autonomous company that runs while you sleep.** Today's tools can't deliver reliable
  unsupervised multi-agent autonomy, and Venom doesn't pretend to. You're the driver.
- **Not a productivity-multiplier with a number.** It gives you structure, review, and memory — not a
  guaranteed multiple.
- **Not infallible.** The gates make the work more rigorous, not perfect. The final call is always
  yours.

## How it works

A **tool-agnostic core** holds the value — the agent roles (portable Markdown), the memory protocol,
the workflow, and the packs. Thin **per-tool adapters** map that core into whatever a specific coding
tool expects. This is what lets one framework target many tools without rewriting the brain.

```
venom/
├── core/            # tool-agnostic: agents/, memory-template/, workflow.md, packs.json, CHARTER_TEMPLATE.md
├── adapters/
│   ├── claude-code/ # core → .claude/agents/ subagents + settings.json
│   ├── codex/       # core → AGENTS.md brief + .venom/agents/ role specs
│   └── gemini/      # core → GEMINI.md + .gemini/commands/venom/ slash-commands
├── bin/             # the venom CLI entry
└── src/             # the CLI (TypeScript → dist/; zero runtime dependencies)
```

Project specifics live only in the generated `CHARTER.md`; the agent specs stay generic and read the
Charter at runtime. Each adapter maps that one core onto its tool's **native** primitives — so the
team is real in each, and each adapter's README notes exactly where a tool's mechanism differs (e.g.
Claude Code trims each role's tools — the `critics`/`security` gates get no Edit/Write; Codex and
Gemini carry that as instruction plus the tool's own sandbox). Adapters ship as plain ESM + JSON with no build step — so
adding a tool is one file, not a rewrite.

**Deeper diagrams** — the core↔adapter mapping, how agents coordinate through shared memory, and the
review loop — are in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## The roster

**Core (every pack):** `boss-1` (orchestrator) · `boss-2` (independent auditor) · `critics`
(correctness/trust gate) · `security` (exploitability gate).

**Specialists (assembled per pack):** `research-head` · `dev-head` · `tech-researcher` ·
`domain-researcher` · `developer-1` · `developer-2` · `testing` · `debugger` · `design` ·
`technical-writer` · `data-engineer` · `ml-engineer` · `literature-reviewer` · `methodologist` ·
`editor` · `fact-checker` · `threat-modeler` · `pentester-advisor`. Plus an optional `marketing`
add-on (`venom add marketing`).

## CLI reference

```
venom init [options]      Install a team into the current project
venom list                Show the available packs and roles
venom add <role>          Add an optional role to an existing install
venom tokens [--pack <id>]  Estimate token footprint + cost across models/presets
venom models [preset]     Show or switch the model preset (quality | balanced | budget)
venom memory <cmd>        Inspect & bound shared memory (stats | compact | index)
venom mcp memory          Run the opt-in MCP memory server (agent calls tools at inference)
venom mcp                 Show how to wire the MCP server into Claude Code / Codex / Gemini
venom --version           Print the version
venom --help              Full help

init options:
  --pack <id>             web-app | data-ml | research-academic | writing-content | security-audit | solo-minimal
  --name <name>           Project name (default: folder name)
  --one-liner <text>      One-line description of the project
  --non-negotiables <t>   Rules that must never be broken (separate with ';')
  --out-of-lane <text>    What the project deliberately won't do
  --tool <id>             claude-code (default) | codex | gemini  (auto-detected if omitted)
  --models <preset>       quality | balanced (default) | budget  — cost/quality tradeoff
  --dir <path>            Target directory (default: current)
  --force                 Overwrite an existing CHARTER.md
  --yes, -y               Non-interactive: use flags + defaults
```

**Token control.** `venom tokens` estimates the per-turn and per-goal footprint and the cost across
models, and compares the presets. `venom models budget` downshifts the workers to a cheaper model —
per-role on Claude Code (real, in each subagent's frontmatter); a recommended session model on
Codex/Gemini. Run `venom tokens` before and after to see the delta.

**Memory control.** Shared memory is append-only, so it grows. `venom memory stats` shows where the
tokens are (hot read-path vs. cold archives) and flags logs over budget; `venom memory compact --write`
keeps the newest entries in each team log and archives the rest to `log.archive.md` — **verbatim, never
deleted** — to bound what agents read each turn; `venom memory index --write` refreshes `INDEX.md`'s
entry catalog so agents scan an index instead of whole logs. Compaction is a safe dry run by default.
Honest scope: Venom doesn't own the model's inference, so these keep memory bounded and navigable —
they can't force selective reading; boss-1 (or you) runs them to keep the tier lean.

**Runtime memory (opt-in MCP).** For the one place Venom *can* help at inference, `venom mcp memory`
runs a small [MCP](https://modelcontextprotocol.io) server that exposes the shared memory as tools the
agent calls directly — `memory_search` (keyword retrieval with field weighting, so it pulls the
relevant slice instead of reading whole files), `memory_read`, `memory_append` (the write-after-turn
step, formatted so it stays compaction-safe), `memory_stats`, and `memory_compact`. It's **opt-in**
and **zero-dependency** (hand-rolled JSON-RPC, no SDK). Run `venom mcp` for the one-line wiring for
Claude Code, Codex, or Gemini. Path-contained to `agent-memory/` (realpath-checked, no symlink escape),
and writes are lock-serialized so concurrent agents on one machine can't lose an append. (Sharing one
`agent-memory/` across multiple hosts assumes unique hostnames — the usual single-machine setup is safe.)

## Token efficiency

Venom doesn't own the model's inference, so it can't make the model spend fewer tokens *per call*. What
it does, honestly, is three things: run the same work on **cheaper models**, keep the **per-turn context
lean**, and **bound memory growth** so a maturing project doesn't balloon the read path. Every number
below is **measured from source** by a rerunnable benchmark — `npm run bench` (writes
`bench/token-savings.json`) — using a char/4 token proxy and the directional prices in
`core/model-rates.json`. They're estimates for comparison, not a billing guarantee.

Measured on the `web-app` pack (14 agents, ~58k tokens of scaffolding per goal — a "goal" is modelled as
~14 agent turns, a 70%-of-team × 1.4-review-loop heuristic, so the absolute dollars scale with that):

| Lever | What it changes | Measured |
|---|---|---|
| **Model preset** — `venom models budget` | Same tokens, cheaper models | **~78% lower cost** than the default preset (~$0.375 → ~$0.083 per goal); ~82% vs `quality` |
| **Lean specs** — the M2 trim | Per-turn context the agents read | Avg spec **7.8% smaller** (2,219 → 2,046 tok), per-turn overhead ~4% — the specs were already tight, so this is modest and we don't inflate it |
| **Memory compaction** — `venom memory compact` | Hot read-path as the project grows | Scales with age: **~55% smaller at 50 log entries, ~96% at 550** (84.7k → 3.7k tok). Near-zero on a fresh project, large on a mature one. Byte-exact: archived + kept reconstruct the original, nothing lost |

So the numbers mean what they say:
- **Cost, not inference tokens.** The preset changes *price*, not token count. `budget` drops every role a
  tier: heads and workers to Haiku-class, **and the bosses and both review gates from Opus down to
  Sonnet** — the 78% depends on that gate downshift, so it is *not* "cheaper with the gates untouched." If
  you want the correctness and security gates to stay on the strongest model, use `balanced` (the default:
  bosses + gates on Opus, workers on Sonnet). The cost saving rests on evidence that a cheaper model holds
  up for extraction- and retrieval-style work; for code-heavy roles that's an extrapolation, so verify on
  your own work before trusting `budget` — this is not a claim that all models are equal.
- **Compaction bounds what's *read*; it can't force selective reading.** Venom doesn't control the
  inference call — boss-1 (or you) runs `compact` to keep the hot log lean. The read-path reduction is
  real and grows with project age.
- **char/4 is a proxy, and the compaction project is synthetic.** The benchmark generates representative
  log entries in the documented format (not a specific real project); the compaction % shifts somewhat with
  entry size (the keep-ratio dominates, but larger entries push it higher), and a real tokenizer will
  differ — so treat these as directional before/after comparisons, not exact figures. Run it yourself:
  `npm run bench`. Regenerate any time — the numbers come from your checkout, not from us.

## Extend it

Venom is built to be extended:

- **Add a pack** — one entry in `core/packs.json` referencing existing roles.
- **Add a role** — a portable spec in `core/agents/` plus a manifest entry per adapter.
- **Add a tool adapter** — one self-contained ESM module. Three ship today as reference
  implementations: `adapters/claude-code`, `adapters/codex`, and `adapters/gemini`.

See the wiring diagram in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#wire-it-to-your-needs)** and the
full steps in [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
git clone <this-repo> && cd venomkit
npm install          # dev-only deps (TypeScript); the published package has zero runtime deps
npm test             # builds, then runs the adapter + CLI test suites
npm run build        # compile the CLI to dist/
npm run bench        # rerun the token benchmark -> bench/token-savings.json (the "Token efficiency" numbers)
```

## License

[MIT](LICENSE).
