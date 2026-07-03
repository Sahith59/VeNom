# The team's shared memory — protocol (read this before you read or write anything)

> This directory (`agent-memory/`) is the team's shared brain. It is the **only** channel between
> the agents. They do not talk to each other in real time — each runs in isolation — so everything
> one agent needs another to know lives here, as a file on disk. The governing rule is simple and
> absolute: **write everything, read selectively.**

If you are an agent: you read the Charter (`CHARTER.md`) and this tier at the start of every task,
and you write your result here before you finish. If you skip the write, your work is invisible to
the rest of the team and lost at the next context reset. That is not a style preference — it is the
mechanism that makes 23 isolated agents behave as one coordinated team.

---

## Why this exists (the synchronization model, honestly)

Today's coding tools run each agent in its own fresh context. There is no shared live memory: an
agent cannot see what another is doing while it does it. So coordination is achieved the only
reliable way it can be — through **shared files, read before acting and written after acting**,
with the orchestrator (boss-1) sequencing the work so two agents never collide. Concretely:

- **Everyone reads `SNAPSHOT.md` first**, so every agent acts from the same current picture of what
  is done, what is in flight, and with whom.
- **Everyone writes their result to their team `log.md`** (and settled conclusions to the distilled
  file), so the next agent builds **on** that work instead of redoing it.
- **Lessons and ADRs** mean a mistake or a decision made once informs every agent afterward.

This is sequential consistency through shared memory — not telepathy. It is strong and real. Any
tool that claims agents coordinate by live mind-meld is overclaiming; this is how it actually works.

---

## The map (what each file is for)

| Path | What it is | Who writes it | Who reads it |
|------|-----------|---------------|--------------|
| `SNAPSHOT.md` | The **live activity board**: current goal, what's in flight and with whom, blocked, open decisions, next up. The single "where we are." | boss-1 (keeps it current) | **everyone, first, every task** |
| `INDEX.md` | The map of this tier — what lives where. | boss-1 / whoever adds structure | anyone orienting |
| `<team>/log.md` | Append-only, `###`-structured record of every meaningful action by that team. | that team's agents | agents who need that team's slice |
| `<team>/architecture.md` / `knowledge.md` / `threat-models.md` | The team's **distilled** settled knowledge — the conclusions, without the log noise. | the head / senior agent of that team | any agent building on settled work |
| `lessons/<team>.md` | Reusable lessons: mistakes caught, patterns found, traps to avoid. Knowledge compounds. | any agent on that team | everyone, before acting (esp. the gates) |
| `adr/<team>/NNNN-title.md` | Architecture/scope Decision Records — load-bearing decisions, append-only, immutable once Accepted. | proposed by the owning agent, gated before Accepted | anyone whose work depends on the decision |
| `decisions/needed.md` | The escalation queue: forks only the human owner can resolve (scope, trust, spend, rule changes). | any agent that hits such a fork | the bosses → the owner |

Team folders: **`dev/`** (builders, testing, debugger, design, data/ml engineers) · **`research/`**
(researchers, marketing, literature-reviewer, methodologist, editor, fact-checker) · **`review/`**
(the gates — critics, security-gate — and boss-2, who log their verdicts here) · **`security/`**
(the Security/Audit pack — threat-modeler, pentester-advisor).

---

## The one rule: write everything, read selectively

**Write (after every meaningful turn — hard rule).** Append a full entry to your team's `log.md`.
The test: *could a fresh agent read your entry and resume exactly what you did and why?* If not,
write more. Unlogged work did not happen.

**Read (selectively — never dump the whole tier into your context).** Follow the read order below.
Never read a whole `log.md`; scan its `###` headers and read only the entries relevant to you.

### The read order (every agent, every task)

1. **`CHARTER.md`** (repo root) — the project's identity, non-negotiables, and scope. The rules.
2. **`SNAPSHOT.md`** — where the team is right now.
3. **Your team's distilled file** (`architecture.md` / `knowledge.md` / `threat-models.md`) — the
   settled conclusions you build on.
4. **A header-scanned slice of your team's `log.md`** — only the recent/relevant entries.
5. **Relevant `lessons/` and `adr/`** — so you don't repeat a caught mistake or violate a settled
   decision.

---

## The log entry format (so everyone can read only their slice)

Every entry in a `log.md` uses this shape. The `###` header line is what lets other agents scan and
skip — keep it present and descriptive.

```
### [YYYY-MM-DD HH:MM] <AGENT-NAME> — <short title of the action>
- **Task:** what you were asked to do (one line).
- **Did:** what you actually did.
- **Result:** the outcome — the artifact, the verdict (PASS/BLOCK), the finding.
- **Refs:** files touched; the ADR/lesson/finding you built on; ids of anything you created.
- **Next / who needs to know:** what this unblocks, or which agent should read it.
```

To read: open the log, scan for `### ` lines, read only the entries that are recent, yours, or
referenced by your task. Skip the rest — that is what keeps this cheap on context.

---

## Keeping memory cheap as it grows (the bounding discipline)

Logs are append-only, so they grow — and the per-turn read cost grows with them. Keep it bounded:

- **Scan the index, not whole logs.** `INDEX.md` carries an auto-generated catalog of every log's
  `###` entry headers. Read it to find the one entry you need, then open only that. Refresh it with
  `venom memory index --write` (or `npx venomkit memory index --write`).
- **Compact old entries out of the hot path.** `venom memory compact --write` keeps the newest
  entries in each `log.md` and moves the rest to `log.archive.md` — **verbatim, never deleted**. The
  archive is cold storage for audit and recovery; agents don't read it in the normal path. Run it when
  a log grows past its budget — `venom memory stats` flags which logs to compact.
- **Distil, don't accumulate.** Settled conclusions belong in the team's distilled file
  (`architecture.md` / `knowledge.md` / `threat-models.md`), not as an ever-growing pile of log
  entries. One distilled paragraph you read beats fifty log entries you scan.
- **SNAPSHOT stays lean.** It is the live board, not a history — boss-1 rewrites it to the current
  state; old detail lives in the log, not here.

Honest note: these are disciplines and tools, not automatic magic. Venom does not run inside the
model's inference, so it cannot *force* selective reading — it keeps the memory bounded and navigable
so the team *can* read cheaply, and boss-1 (or you) runs `venom memory compact` to keep it that way.

---

## lessons/ — the team learns (knowledge compounds, rules stay fixed)

When you make or catch a mistake, or find a reusable pattern or trap, append a lesson to
`lessons/<your-team>.md` with evidence (a ref to the log entry or code that proves it). Merge a
duplicate into the existing lesson and raise its confidence rather than adding a near-copy; never
delete history. The gates (critics, security) read lessons before every review — a repeat of a
logged lesson is a **BLOCK with the lesson cited**, which is how a lesson becomes an enforced check.

**The firewall (never cross):** knowledge compounds, but **rules stay fixed**. No agent ever edits
`CHARTER.md` or any agent spec. If a lesson implies a *rule* should change, that is the owner's call
alone — write it to `decisions/needed.md`. When a lesson and a rule conflict, the rule wins.

---

## adr/ — load-bearing decisions (append-only, immutable)

A decision that other work will depend on (an architecture choice, a scope call) becomes an ADR in
`adr/<team>/`. ADRs are **append-only and immutable once Accepted** — to change one, write a new ADR
that supersedes it; never edit an Accepted ADR in place. Format and rules are in `adr/README.md`. An
ADR is Accepted only after it passes its gate (dev ADRs: critics + security; research/scope ADRs:
critics).

---

## decisions/needed.md — the escalation queue (escalate, never stall)

Blocked, or at a fork that touches scope, trust, spend, or a rule? Do not guess and do not stall.
Append it to `decisions/needed.md` and move to your next independent task. Only the bosses carry
these to the owner, and only the owner resolves a rule or scope change. See that file for the format.

---

## How this makes the team synchronize (the payoff)

- **`SNAPSHOT` = one shared picture.** Every agent starts from the same current state, so nobody
  acts on a stale view or duplicates in-flight work.
- **Logs = work compounds.** Agent B reads Agent A's written result and builds on it, citing it, so
  the chain of reasoning is traceable and nothing is redone.
- **Lessons + ADRs = the team gets smarter.** A mistake caught once, or a decision made once,
  informs every agent afterward — the memory remembers what an individual agent cannot.
- **boss-1 sequences the work** and never wakes two agents onto the same files; parallel builders
  get separate git worktrees. There are no out-of-band channels — forks go to `decisions/`, results
  go to the log. Everything stays in this space.

Protect the write-discipline above all. Break it, and the team fractures back into 23 disconnected
individuals.
