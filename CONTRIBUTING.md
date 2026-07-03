# Contributing to Venom

Thanks for wanting to make this better. Venom is meant to be used by real people on real projects, so
the bar is quality and honesty over speed. This guide covers how it's built and how to extend it.

## The non-negotiables for any contribution

These are the rules the project guards; PRs that break them won't merge:

1. **Honest positioning — no productivity-multiple claims.** No "10x", no "50x", no "AI does your job
   for you" in any copy. We claim what's true and demonstrable: specialized roles, independent review
   gates, and persistent memory. That honesty is why people trust it.
2. **The core stays tool-agnostic.** `core/` (agent specs, memory template, workflow, packs) must
   never contain tool-specific syntax or project specifics. Tool details live only in `adapters/`;
   project details live only in the generated `CHARTER.md`.
3. **Zero runtime dependencies.** The published package must run with no runtime deps. TypeScript is a
   dev-only tool. Adapters are plain ESM + JSON. Keep it that way — it's a trust and speed feature.
4. **Nothing is claimed done until tests pass.** `npm test` must be green, and new behavior needs a
   test.

## Dev setup

```bash
git clone <this-repo> && cd venomkit
npm install          # dev-only deps (TypeScript, @types/node)
npm test             # builds, then runs the adapter + CLI suites
npm run build        # compile the CLI (src/ → dist/)
```

## Project layout

```
core/                 # tool-agnostic (the value)
  agents/*.md         # portable role specs (no frontmatter, no project specifics)
  memory-template/    # the agent-memory scaffold + protocol
  workflow.md         # the human's daily-use guide
  packs.json          # pack definitions + the role catalog
  CHARTER_TEMPLATE.md # placeholders filled at init
adapters/
  claude-code/        # Claude Code subagents (manifest, settings, renderer)
  codex/              # Codex AGENTS.md brief + .venom/agents/ role specs
  gemini/             # Gemini GEMINI.md + /venom:<role> slash commands
src/                  # the CLI (TypeScript → dist/)
test/                 # adapter + CLI end-to-end tests
```

## How to extend Venom

### Add a pack
Add an entry under `packs` in `core/packs.json` whose `adds` reference roles that already exist in the
`roles` catalog. Keep every role's reporting line resolvable: if a pack omits `research-head` or
`dev-head`, any worker that reports to that head needs a `reportsToFallback` (usually `boss-1`), and
its spec must say so. Run `npm test` — the suite validates pack coherence.

### Add a role
1. Write a portable spec at `core/agents/<name>.md` — no YAML frontmatter, no project specifics; it
   references the Charter in prose. Match the structure of the existing specs (read-first, what you
   own, how you coordinate, end-of-turn checklist).
2. Add it to the `roles` catalog in `core/packs.json` (`team`, `title`, `summary`, `reportsTo`).
3. Add a per-role frontmatter entry to the Claude Code manifest (`adapters/claude-code/manifest.json`)
   with `model`, `tools`, and `description`. The Codex and Gemini adapters read role metadata straight
   from `packs.json`, so they need no manifest entry.
4. Add it to whichever pack(s) should staff it. Run `npm test` — every adapter's suite installs each
   pack and checks the counts.

### Add a tool adapter (Codex, Gemini, …)
An adapter is one self-contained ESM module (`adapters/<id>/adapter.mjs`) exporting:
- `meta` — `{ id, name, agentsDir, settingsPath, detect(dir) }`
- `install(opts)` — reads the portable `core/agents/*.md`, wraps each in whatever the target tool
  expects, writes the tool's config, places `CHARTER.md` + `agent-memory/`, and records
  `.venom/install.json`. Keep it idempotent and non-clobbering — see `adapters/claude-code/adapter.mjs`
  as the reference, and its `README.md` for the contract.

The `core/` layer never changes for a new tool — only the thin mapping.

## Pull requests

- Keep PRs focused; explain the *why*, not just the *what*.
- Include tests for new behavior; make sure `npm test` is green.
- Match the surrounding style. Don't add dependencies without a strong reason.
- Be honest in the description about what's tested and what isn't.

## Reporting issues

Open an issue using the **bug report** or **feature request** template — they prompt for what's needed
(what you expected, what happened, your OS + Node version, and the command you ran).

For anything security-sensitive, **do not** open a public issue — follow the [Security Policy](SECURITY.md)
to report it privately. And please keep discussion within the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
