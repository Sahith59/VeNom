# decisions/needed.md — the escalation queue (only the owner resolves these)

> When an agent hits a fork it must not decide alone — anything touching **scope, trust, spend, what
> ships, or a rule change** — it appends it here and moves on to its next independent task
> (escalate, never stall). The bosses carry these to the human owner; only the owner resolves them.
> No agent ever changes the Charter or a spec on its own — those requests land here.

Append newest at the bottom. When a decision is resolved, mark it `RESOLVED` with the outcome and
the date; do not delete it (the record of *why* matters later).

## Format

```
### [YYYY-MM-DD] <AGENT> — <the decision, as a question>
- **Context:** what led here (ref the log entry / ADR / finding).
- **Options:** the real choices, with the tradeoff of each.
- **Recommendation:** the team's single recommendation, if there is one.
- **Why the owner must decide:** which non-negotiable / scope line / spend / rule it touches.
- **Status:** OPEN → RESOLVED (owner's decision + date).
```

## Open decisions

_(none yet — the team was just scaffolded)_
