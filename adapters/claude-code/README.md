# Claude Code adapter

Maps Venom's tool-agnostic `core/` into a working [Claude Code](https://claude.com/claude-code)
setup. This is the one fully-working adapter for v1.

## What `install()` writes into a project

| Path | What | Re-run behavior |
|------|------|-----------------|
| `.claude/agents/<role>.md` | Each pack role: portable spec body + Claude Code frontmatter (`name`, `description`, `model`, `tools`) from `manifest.json` | Rewritten; agents dropped from the pack are cleaned up |
| `.claude/settings.json` | Safe permissions (allow reads · ask before impact · hard-deny danger) | **Merged** into existing settings, never clobbered |
| `CHARTER.md` | The project's constitution (filled by the CLI) | **Kept** if it already exists (pass `force` to overwrite) |
| `CLAUDE.md` | Lead-session brief — makes the session operate as boss-1 and imports `CHARTER.md` | Only the `VENOM:BEGIN…VENOM:END` block is managed; your notes outside it survive |
| `agent-memory/` | The memory tier (SNAPSHOT, logs, lessons, ADRs, protocol) | Copied without overwriting live memory |
| `.venom/workflow.md` | The human's daily-use guide | Refreshed |
| `.venom/install.json` | Install record (version, pack, roles) for updates + stale-agent cleanup | Rewritten |

## The pieces

- **`manifest.json`** — per-role Claude Code frontmatter. `model` is opus for boss-1/boss-2/critics/security, sonnet otherwise. `tools` omitted = all tools; the read-only gates omit Edit/Write; the advisory security roles omit Bash so they cannot execute. Tune freely in a fork.
- **`settings.template.json`** — the safe-permission floor. Allows safe reads, asks before Edit/Write/commit/install, hard-denies push/force-push/reset --hard/rm -rf/reading secrets/curl|wget.
- **`CLAUDE.md.template`** — the root brief. `{{PROJECT_NAME}}` is filled at install; `@CHARTER.md` makes the lead session auto-load the Charter.
- **`adapter.mjs`** — zero-dependency ESM. Exports `meta` and `install(opts)`. Safe to re-run.

## Usage

```js
import { install } from "./adapter.mjs";
install({
  coreDir: "/path/to/venom/core",
  targetDir: "/path/to/your/project",
  pack: "web-app",
  charterContent: "# My Project — Team Charter\n...",
  projectName: "My Project",
  version: "0.1.0",
});
```

## Writing another adapter (Codex, Gemini, …)

An adapter is a self-contained ESM module that exports:

- `meta` — `{ id, name, agentsDir, settingsPath, detect(targetDir) }`
- `install(opts)` — reads the portable `core/agents/*.md`, wraps each in whatever the target tool
  expects, writes the tool's config, places `CHARTER.md` + `agent-memory/`, and records
  `.venom/install.json`. Keep it idempotent and non-clobbering (see `adapter.mjs` for the pattern).

The `core/` layer never changes — only the thin mapping to "how this tool loads agents" does.
