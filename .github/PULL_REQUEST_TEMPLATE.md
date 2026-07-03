## What this changes

<!-- One or two sentences. If it closes an issue, say "Closes #123". -->

## Why

<!-- The problem this solves, not just the mechanics of the change. -->

## Type of change

- [ ] Bug fix
- [ ] New pack / role
- [ ] New tool adapter
- [ ] CLI or core change
- [ ] Docs only

## Checklist

- [ ] `npm test` passes locally (it builds, then runs the adapter + CLI suites).
- [ ] No new runtime dependencies — the published package ships zero.
- [ ] `core/` stays tool-agnostic: no tool-specific syntax or project specifics leaked into `core/agents/`.
- [ ] Public-facing copy makes no productivity-multiplier claim (no "10x" / "50x").
- [ ] If I added a role or pack, I updated `core/packs.json` and each adapter's manifest, and kept every reporting line resolvable.
- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md).
