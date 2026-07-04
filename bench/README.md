# Token benchmark (M5 — "prove it")

Reproducible measurement of Venom's token/cost levers. Every figure in the README's
**Token efficiency** section comes from here — nothing is hand-written.

```bash
npm run bench                 # build + run, writes bench/token-savings.json + a table
node bench/benchmark.mjs       # run against an existing dist/ build
node bench/benchmark.mjs --json  # write JSON only (no table)
```

## What it measures

1. **Model selection (cost)** — `$/goal` for each preset (`quality` / `balanced` / `budget`) on the
   `web-app` pack. Same token count, cheaper models → lower price. From the shipped presets and
   `core/model-rates.json`.
2. **Lean specs (context)** — current spec tokens vs. the pre-trim specs read from git history
   (`908d27e~1`). Skipped with a note if git history isn't available (e.g. a shallow clone).
3. **Memory compaction (hot read-path)** — a synthetic growing project (50 / 200 / 550 log entries),
   hot read-path tokens before vs. after `compact` (keep newest 20). Includes a byte-exact check that
   archived + kept reconstruct the original — nothing lost.

## Honesty

- **char/4 token proxy** — indicative, not an exact tokenizer. The value is a consistent before/after.
- **Directional prices** — from `core/model-rates.json`; edit them for your own rates.
- **Not inference tokens** — Venom doesn't own the LLM call. Model selection lowers *cost*, lean specs
  lower the *per-turn context*, compaction *bounds* memory growth. None reduce what the model spends at
  inference.

`test/bench.test.mjs` runs this and asserts the invariants (costs ordered, compaction byte-exact and
monotonic) so the numbers can't silently rot.
