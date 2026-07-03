# INDEX — the map of the team's shared memory

> A quick map of `agent-memory/`. Start with `README.md` for the protocol and `SNAPSHOT.md` for the
> current state. This index just says what lives where.

## Read-first files
- `README.md` — the memory protocol (write everything, read selectively; formats; the firewall).
- `SNAPSHOT.md` — the live activity board: where the team is right now.
- `../CHARTER.md` — (repo root) the project's identity, non-negotiables, and scope. The rules.

## Team records
- `dev/log.md` + `dev/architecture.md` — the Development team: builders, testing, debugger, design,
  and (in the Data/ML pack) data-engineer, ml-engineer.
- `research/log.md` + `research/knowledge.md` — the Research team: tech- and domain-researcher, and
  (per pack) marketing, literature-reviewer, methodologist, editor, fact-checker.
- `review/log.md` — the gates' verdicts: critics, the security gate, and boss-2's independent takes.
- `security/log.md` + `security/threat-models.md` — the Security/Audit pack: threat-modeler,
  pentester-advisor.

## Cross-cutting
- `lessons/<team>.md` — reusable lessons per team (knowledge compounds; rules stay fixed).
- `adr/<team>/NNNN-*.md` — append-only Architecture/scope Decision Records (see `adr/README.md`).
- `decisions/needed.md` — the escalation queue for forks only the human owner can resolve.

## The teams, at a glance
`dev` · `research` · `review` (gates) · `security` (security pack). Not every pack uses every team;
the folders are present so no agent spec ever points at a missing path.
