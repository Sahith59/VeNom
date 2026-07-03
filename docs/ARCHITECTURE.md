# Architecture & wiring

How Venom is put together, how the agents actually coordinate, and how you extend it. The
higher-level "how your team works / install / packs" diagrams live in the [README](../README.md);
this doc goes deeper.

---

## Tool-agnostic core + thin adapters

The value lives in a **tool-agnostic core** — the roles, the memory protocol, the workflow, the
packs. A **thin per-tool adapter** maps that core into whatever a specific coding tool expects. One
brain, many tools.

```mermaid
flowchart LR
    subgraph CORE["core/ — tool-agnostic (the brain)"]
      direction TB
      AG["agents/*.md<br/>portable role specs"]
      MM["memory-template/<br/>the shared-memory scaffold"]
      WF["workflow.md<br/>daily-use guide"]
      PK["packs.json<br/>packs + role catalog"]
      CH["CHARTER_TEMPLATE.md"]
    end
    subgraph ADP["adapters/ — thin, per-tool (all working)"]
      direction TB
      CC["claude-code"]
      CX["codex"]
      GM["gemini"]
    end
    CORE --> CC
    CORE --> CX
    CORE --> GM
    CC --> O1[".claude/agents/ subagents<br/>+ .claude/settings.json"]
    CX --> O2["AGENTS.md brief<br/>+ .venom/agents/ specs"]
    GM --> O3["GEMINI.md<br/>+ .gemini/commands/venom/"]
```

All three also write the shared, tool-agnostic surfaces: `CHARTER.md`, `agent-memory/`, and
`.venom/`. Each adapter maps the same core onto that tool's **native** primitives — Claude Code's
subagents, Codex's `AGENTS.md`, Gemini's `GEMINI.md` + slash-commands — and each adapter's README
notes exactly where a tool's mechanism differs (e.g. Claude Code enforces the read-only gates by
tool permission; Codex and Gemini carry that constraint as instruction plus the tool's own sandbox).

The agent specs never contain tool syntax or project specifics — a project's details live only in
the generated `CHARTER.md`, which every agent reads at runtime. Adapters ship as plain ESM + JSON
with no build step, so adding a tool is one file, not a rewrite.

---

## How the agents coordinate (shared memory, not live chat)

Agents run in isolation — one cannot see another while it works. They coordinate through **files**
under `agent-memory/`, read before acting and written after, with boss-1 sequencing the work. It is
honest sequential coordination, not telepathy — and it survives a context reset.

```mermaid
sequenceDiagram
    actor You
    participant B1 as boss-1
    participant Mem as agent-memory
    participant A as agent A
    participant B as agent B
    You->>B1: a goal
    B1->>Mem: write the plan to SNAPSHOT.md
    B1->>A: wake with a bounded task
    A->>Mem: read SNAPSHOT + lessons (build on prior work)
    A->>Mem: write result to the team log
    A-->>B1: return result
    B1->>B: wake the next task
    B->>Mem: read A's result, build on it
    B-->>B1: return result
    B1-->>You: one reconciled recommendation
    Note over Mem: the only channel between agents<br/>is these files — write everything,<br/>read selectively
```

`SNAPSHOT.md` is the live activity board everyone reads first; team `log.md` files are the durable
record; `lessons/` and `adr/` mean a mistake or decision made once informs every agent afterward.

---

## The review loop — nothing ships unreviewed

Work goes through a build/test/debug loop, then two independent, read-only gates. Both must pass;
either one blocks. The gates flag and block — they never fix — so they stay honest checks.

```mermaid
flowchart TD
    DEV["developer builds<br/>for load, failure, edge cases"] --> TEST["testing tries to break it"]
    TEST -->|"fails"| DEV
    TEST -->|"green"| DBG["debugger:<br/>any happy-path shortcuts?"]
    DBG -->|"shortcut found"| DEV
    DBG -->|"durable"| CR["critics gate<br/>correctness + trust"]
    DBG -->|"durable"| SE["security gate<br/>exploitability"]
    CR -->|"BLOCK, with reasons"| DEV
    SE -->|"BLOCK, with reasons"| DEV
    CR -->|"PASS"| DONE["done — ready for<br/>you to approve"]
    SE -->|"PASS"| DONE
```

For non-code packs (research, writing) the gate is critics against your Charter; security applies
wherever there is code or config to exploit.

---

## Wire it to your needs

Venom is built to extend. The `core/` layer never changes for a new need — only the thin mapping does.

```mermaid
flowchart LR
    NEED["your need"] --> Q{"what do you<br/>want to change?"}
    Q -->|"a new team combo"| PK["add a pack<br/>= 1 entry in packs.json"]
    Q -->|"a new specialist"| RL["add a role<br/>= spec + manifest + catalog"]
    Q -->|"a new coding tool"| AD["add an adapter<br/>= 1 .mjs file"]
    PK --> CORE["core/ stays the same —<br/>only the thin mapping changes"]
    RL --> CORE
    AD --> CORE
```

- **Add a pack** — one entry under `packs` in `core/packs.json` whose `adds` reference existing roles.
  Keep reporting lines resolvable (a worker whose head isn't in the pack needs a `reportsToFallback`).
- **Add a role** — a portable spec in `core/agents/`, a `roles` catalog entry, and a per-adapter
  manifest entry (`model`, `tools`, `description`).
- **Add a tool adapter** — one ESM module exporting `meta` + `install(opts)`. Three ship today as
  reference implementations: [`claude-code`](../adapters/claude-code/README.md),
  [`codex`](../adapters/codex/README.md), and [`gemini`](../adapters/gemini/README.md).

Full steps are in [CONTRIBUTING.md](../CONTRIBUTING.md).
