# Gemini CLI adapter

Maps Venom's tool-agnostic `core/` into a working [Gemini CLI](https://github.com/google-gemini/gemini-cli)
setup.

Gemini loads **`GEMINI.md`** as context automatically, and runs TOML files under `.gemini/commands/`
as **custom slash commands**. So each Venom role becomes a real, native command: typing
`/venom:security` makes Gemini adopt the security auditor with its full operating spec.

## What `install()` writes into a project

| Path | What | Re-run behavior |
|------|------|-----------------|
| `GEMINI.md` | Team briefing: read-first order, the roster for your pack, the memory protocol, the two gates, and safe-operation rules. Gemini loads it automatically (it's Gemini's default context file). | Only the `VENOM:BEGIN…VENOM:END` block is managed; your notes outside it survive |
| `.gemini/commands/venom/<role>.toml` | One slash command per pack role — `/venom:<role>` adopts that specialist's full spec | Rewritten; roles dropped from the pack are cleaned up |
| `CHARTER.md` | The project's constitution (filled by the CLI) | **Kept** if it already exists (pass `force` to overwrite) |
| `agent-memory/` | The memory tier (SNAPSHOT, logs, lessons, ADRs, protocol) | Copied without overwriting live memory |
| `.venom/workflow.md` | The human's daily-use guide | Refreshed |
| `.venom/install.json` | Install record (version, pack, roles) for updates + stale cleanup | Rewritten |

## Using it

```bash
npx venomkit init --tool gemini
```

Then open the project in Gemini CLI and either state your goal (GEMINI.md briefs it as **boss-1**) or
hand the wheel to a specialist directly:

```
/venom:boss-1 ship the login flow
/venom:security          # audit the current diff as the read-only security gate
/venom:critics           # correctness + Charter non-negotiables
```

Each command injects that role's full spec as the prompt and forwards whatever you type after it via
`{{args}}`.

**Run it safely.** Keep Gemini's default approval prompts (don't use `--yolo` for this team), and
consider `gemini --sandbox` to isolate file and network side-effects.

## Honest fidelity note

Claude Code has first-class subagents and per-role tool permissions, so on Claude Code the read-only
gates (`critics`, `security`) get **no Edit/Write** and the no-execution advisors (`threat-modeler`,
`pentester-advisor`) get **no Bash** — trimmed at the tool level. Gemini's tool settings are session-wide, not per-command, so here those
limits are carried as explicit **instructions** in each role's prompt and in `GEMINI.md`, backed by
Gemini's approval prompts and sandbox. Same team and same protocol — mapped honestly onto Gemini.

## The pieces

- **`GEMINI.template.md`** — the briefing. `{{PROJECT_NAME}}`, `{{PACK_NAME}}`, and `{{ROSTER}}` are
  filled at install.
- **`adapter.mjs`** — zero-dependency ESM. Exports `meta` and `install(opts)`. Renders each role as a
  TOML custom command using a literal string (with a hard guard against unsafe spec content).
  Idempotent and non-clobbering, like every Venom adapter.
