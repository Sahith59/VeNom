# Architecture / Decision Records (ADRs)

> A load-bearing decision — one that other work will depend on (an architecture choice, a scope
> call, a technology commitment) — is recorded here so it is not silently reversed or re-litigated.
> ADRs live in `adr/<team>/` (`dev/`, `research/`, `review/`, `security/`).

## The rules (non-negotiable)

- **Append-only and immutable once Accepted.** To change an Accepted decision, write a **new** ADR
  that supersedes the old one (`Superseded by NNNN`). Never edit an Accepted ADR in place — the
  history of what was decided and why is the point.
- **Gated before Accepted.** A dev/architecture ADR is Accepted only after **critics + security**
  clear it. A research/scope ADR is Accepted only after **critics** clears it against the Charter's
  boundary. Until then its status is `Proposed`.
- **One decision per ADR.** Numbered per team: `dev/0001-title.md`, `dev/0002-title.md`, …

## Format

```
# ADR-<NNNN> — <title>

- **Status:** Proposed | Accepted | Superseded by ADR-NNNN
- **Date:** YYYY-MM-DD
- **Team:** dev | research | review | security
- **Deciders:** which agents; which gate(s) cleared it.

## Context
The forces at play — what problem, what constraints, what the Charter requires here.

## Decision
The choice made, stated plainly.

## Consequences
What this makes easy, what it makes hard, what it rules out, what to revisit later.

## Alternatives considered
The real options that were weighed, and why they lost.
```

Number ADRs sequentially within each team folder, starting at `0001`.
