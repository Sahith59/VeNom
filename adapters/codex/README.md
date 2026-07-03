# Codex adapter

Maps Venom's tool-agnostic `core/` into a working [Codex](https://github.com/openai/codex) setup.

Codex reads **`AGENTS.md`** at the repo root automatically, so that file is where the team lives here:
it briefs the single Codex agent to operate as the Venom team (boss-1 by default), points at each
role's full spec, and encodes the shared-memory protocol and the two review gates. The role specs
themselves are written verbatim to `.venom/agents/` for Codex to open and adopt on demand.

## What `install()` writes into a project

| Path | What | Re-run behavior |
|------|------|-----------------|
| `AGENTS.md` | Team briefing: read-first order, the roster for your pack, the memory protocol, the two gates, and safe-operation rules | Only the `VENOM:BEGIN…VENOM:END` block is managed; your notes outside it survive |
| `.venom/agents/<role>.md` | Each pack role's portable spec, verbatim | Rewritten; roles dropped from the pack are cleaned up |
| `CHARTER.md` | The project's constitution (filled by the CLI) | **Kept** if it already exists (pass `force` to overwrite) |
| `agent-memory/` | The memory tier (SNAPSHOT, logs, lessons, ADRs, protocol) | Copied without overwriting live memory |
| `.venom/workflow.md` | The human's daily-use guide | Refreshed |
| `.venom/install.json` | Install record (version, pack, roles) for updates + stale cleanup | Rewritten |

## Using it

```bash
npx venomkit init --tool codex
```

Then open the project in Codex and give it your goal — it operates as **boss-1** per `AGENTS.md`. To
work as a specialist, tell it to adopt that role (e.g. "act as the security gate: `.venom/agents/security.md`").

**Run it safely.** Codex enforces its sandbox at the runtime layer, so start it with:

```bash
codex --sandbox workspace-write --ask-for-approval on-request
```

(or set the equivalent in `~/.codex/config.toml`).

## Honest fidelity note

Claude Code has first-class subagents and per-role tool permissions, so on Claude Code the read-only
gates (`critics`, `security`) get **no Edit/Write** and the no-execution advisors (`threat-modeler`,
`pentester-advisor`) get **no Bash** — trimmed at the tool level. Codex has no per-role permission layer, so here those limits are carried
as explicit **instructions** in `AGENTS.md` and each spec, backed by Codex's own sandbox and approval
flags. Same team and same protocol — mapped honestly onto what Codex actually provides.

## The pieces

- **`AGENTS.template.md`** — the briefing. `{{PROJECT_NAME}}`, `{{PACK_NAME}}`, and `{{ROSTER}}` (the
  per-pack role table) are filled at install.
- **`adapter.mjs`** — zero-dependency ESM. Exports `meta` and `install(opts)`. Idempotent and
  non-clobbering, like every Venom adapter.
