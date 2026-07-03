# How your team works — the daily-use guide

> The agent specs tell each agent how to behave. This file tells **you** how to drive the team: how
> to give it work, how much rope to give it, how work flows, where the review gates sit, how the
> shared memory keeps everything in sync — and, just as important, **what to do when something goes
> wrong.** Read it once; it will make the whole thing feel obvious.

---

## TL;DR — the five things that matter

1. **You talk to boss-1.** One point of contact, not your whole roster. It delegates, integrates, and
   brings you one answer.
2. **You set the leash.** Tell boss-1 how much autonomy to take (tight or long). You can change it any
   time.
3. **Nothing ships unreviewed.** Code passes both gates — critics (correctness/trust) and security
   (exploitability); non-code work passes critics. Either red blocks, and **you** make the final call.
4. **The memory is the source of truth.** Everything lives in `agent-memory/`; it survives context
   resets. Open `SNAPSHOT.md` any time to see the team's last recorded state.
5. **You are the driver.** This is not an autonomous company that runs while you sleep. It gives you
   structure, review, and memory — you still steer and approve.

---

## Who is on your team (it depends on your pack)

Every pack ships the **core four** — `boss-1` (orchestrator), `boss-2` (independent auditor),
`critics` and `security` (the two gates) — plus the **full memory tier**. Your chosen pack adds the
specialists:

| Pack | Adds on top of the core four |
|------|------------------------------|
| Web/App (default) | research-head, dev-head, tech- & domain-researcher, developer-1/2, testing, debugger, design, technical-writer |
| Data/ML | research-head, dev-head, tech-researcher, data-engineer, ml-engineer, testing, debugger, technical-writer |
| Research/Academic | research-head, tech- & domain-researcher, literature-reviewer, methodologist, technical-writer |
| Writing/Content | research-head, domain-researcher, technical-writer, editor, fact-checker |
| Security/Audit | tech-researcher, threat-modeler, pentester-advisor, technical-writer — and the `security` gate leads the review, backed by the threat-modeler + pentester-advisor |
| Solo Minimal | dev-head, developer-1, testing, technical-writer |

If a role below isn't in your pack, its job is simply not staffed — the flow is the same, just with
fewer specialists.

---

## You talk to boss-1

```
                        YOU (the owner)
                            │  (you approve what the bosses escalate)
                   ┌────────┴────────┐
                boss-1            boss-2
             (orchestrates)   (audits the big calls)
                   │
        ┌──────────┼───────────┬─────────────┐
   research-head  dev-head   critics       security
        │           │        (gate)        (gate)
   researchers   builders, testing, debugger, design, writers
```

boss-1 is your single point of contact; boss-2 comes to you only alongside boss-1, on the big calls.
The specialists report up through their heads — but the two gates (critics, security) and boss-2
report to boss-1 **directly**, as the diagram shows. You never micromanage a worker — you give boss-1
a goal and it conducts. (For high-stakes work you can also invoke critics, security, or boss-2
yourself from a second session — see the review-board pattern below.)

---

## Start of a session

1. **Make sure `CHARTER.md` is filled in.** It's the team's constitution — the project's identity,
   its non-negotiables, and its scope. Every agent reads it before acting, so **read the generated
   Charter yourself first and make sure it's right** — it drives every decision the team makes. (If
   it's blank, the agents will stop and ask you to complete it, by design.)
2. **boss-1 reads the Charter and `agent-memory/SNAPSHOT.md` before it does anything.** The installer
   sets your lead session up to load the Charter automatically where your coding tool supports it —
   and regardless of that, reading the Charter and SNAPSHOT first is the mandated first step in every
   agent's spec.
3. **State your goal.** Resuming earlier work? boss-1 picks up from `SNAPSHOT.md` — the memory lives
   in the repo, not in any one session, so a fresh session resumes exactly where the last left off.

---

## Give a goal, set the leash (the autonomy dial)

Tell boss-1 **how much autonomy** to take. This is your most useful control.

- **Tight leash** — surface before any real change (before a commit, before anything ships); loop
  everything else autonomously. Use it when exploring or when the work is delicate.
- **Long leash** — run the whole goal end to end; surface only at a genuine fork or a real block, then
  bring the finished result plus the log. Use it when the goal is clear and the path is trusted.

**Always-surface events — the team stops and comes to you no matter how long the leash:**

- anything touching a Charter non-negotiable (scope, trust, a possibly-wrong result, going
  out-of-lane),
- a loop that is not converging (the same failure recurring, two agents oscillating),
- anything that spends money or decides what ships,
- anything an agent flagged "needs approval."

You can **retighten the leash at any time** — if a long-leash run makes you nervous, say so and boss-1
drops to surfacing before each step.

---

## Steering mid-flight

You are not locked in once you start. At any point you can:

- **Redirect** — "actually, prioritize X first." boss-1 re-plans and updates `SNAPSHOT.md`.
- **Correct** — "that approach is wrong because…" boss-1 sends the correction down with your reason.
- **Pause / interrupt** — stop a run that's going the wrong way; boss-1 writes the current state to
  `SNAPSHOT.md` so nothing is lost.
- **Change your mind on the goal** — just say so; the team re-plans. You don't need to restart the
  session.

---

## What happens after you give a goal (the handoff)

You don't orchestrate this — boss-1 does — but here's what to expect:

1. **boss-1 decomposes** the goal into bounded tasks and records the plan in `SNAPSHOT.md`.
2. It **briefs the owning head** (dev-head to build, research-head to investigate) with full context.
3. The head **assigns workers.** When two builders work at once, dev-head puts each on its **own git
   worktree** so their edits can't collide. *(You can confirm this in the dev log; if you ever see two
   agents editing the same files, stop and have dev-head separate them.)*
4. Workers do the work, **write their results to `agent-memory/`**, and return to the head.
5. The head integrates and **routes finished code through BOTH gates in parallel** — critics and
   security.
6. A gate **BLOCK** goes back to the worker with specific reasons → fix → re-review, until both pass.
7. The head reports up; boss-1 integrates; for expensive-to-be-wrong calls it consults boss-2; and the
   **one reconciled result** comes to you.

---

## What "done" actually means

The team does not get to call something done just because it runs. What "done" requires depends on
what the work is:

- **For code (packs with a dev department):** the project's existing test bar is green **+** the
  debugger has not flagged a happy-path shortcut **+** dev-head has signed off on integration **+**
  *both* gates (critics and security) passed. "It compiles" and "it worked once in the demo" are
  explicitly **not** done.
- **For research or written deliverables (packs with no dev department — Research, Writing, Solo
  Minimal without code):** the owning head has signed off **+** critics has passed it against your
  Charter (and, in the Writing pack, the fact-checker has cleared the claims). Security applies
  wherever the work includes code or config to exploit — a pure prose deliverable has nothing for it
  to audit.

Either way: if an agent claims done, you're entitled to ask for the gate verdicts — they're in
`agent-memory/review/log.md`.

---

## The two gates — nothing ships unreviewed

Before anything is shippable it passes two independent, **read-only** gates, in parallel:

- **critics** — correctness and your Charter's non-negotiables; also checks the work against past
  lessons ("have we made this mistake before?").
- **security** — exploitability: secrets, injection, auth/authz holes, dependency vulns, insecure
  config, and whether your project's own trust promises hold in the code.

This is the bar for **code**: both green, or it doesn't ship — **either one red blocks.** For work
with no code (a research briefing, a written deliverable), critics is the gate against your Charter;
security audits code and config, so it applies wherever there is something to exploit. The gates flag
and block; they never fix, so they stay honest independent checks instead of becoming another pair of
hands.

**Propose / dispose:** the team *proposes*; **you dispose.** The gates and bosses do the rigorous work
of getting a recommendation right, but the final call on scope, trust, spend, and what ships is always
yours. The team is built to earn your approval, not to route around it.

---

## The loops that run without you

Between your checkpoints, these run autonomously — this is where quality compounds while you're not
babysitting:

- **build ↔ test ↔ debug** — builder writes, testing tries to break it, debugger flags shortcuts,
  builder fixes; until green and un-shortcut.
- **gates ↔ builder** — critics + security block with reasons; work returns, is fixed, re-reviewed;
  until both pass.
- **research ↔ research ↔ critics** — researchers coordinate, the head synthesizes, critics gate any
  scope-expanding claim against your Charter.
- **boss-1 ↔ boss-2** — independent takes on a big decision, reconciled before it reaches you.

---

## How the team stays in sync — and how you verify it

The agents don't talk in real time; each runs in its own context. They coordinate through **shared
files** under `agent-memory/`, read before acting and written after, with boss-1 sequencing the work.
It's honest sequential coordination — not live telepathy. For you, that means everything the team does
leaves **receipts you can check**:

- **`agent-memory/SNAPSHOT.md`** — the live activity board: current goal, what's in flight and with
  whom, what's blocked, what's next. Open it any time.
- **`agent-memory/review/log.md`** — every gate verdict (PASS/BLOCK) with exactly what was checked.
  This is how you confirm a "done" was actually reviewed.
- **`agent-memory/<team>/log.md`, `lessons/`, `adr/`** — the durable record of what was done, what the
  team learned, and the load-bearing decisions. This is why the team doesn't forget between sessions
  and doesn't repeat a caught mistake.

You never *have* to read these — boss-1 gives you a plain-English summary — but they're your ground
truth when you want to trust-check a claim rather than take it on faith.

---

## The two-terminal pattern (builder + review board) — for work you'd hate to get wrong

For high-stakes work, run **two sessions of your coding tool on the same project**:

- **Terminal 1 — the builder.** boss-1 orchestrates the build here.
- **Terminal 2 — your review board.** A **fresh** session with independent context. Point critics,
  security, or boss-2 at what Terminal 1 produced and ask for an independent verdict — including on
  boss-1's *own* conclusions. Fresh context is what makes the second read genuinely independent; it
  catches what a self-review inside the same session can rationalize past.

Keep Terminal 2 a **read-only review board** — not a second builder. Two building sessions editing the
same repo at once reintroduce exactly the same-file collisions the worktree rule prevents; the review
board reads and judges, it doesn't write code.

For routine work the in-session gates are enough. Reach for the second terminal when being wrong is
expensive — a security-sensitive change, a scope decision, anything about to ship.

---

## When something goes wrong — troubleshooting & recovery

A team you can trust is one you know how to correct. Common situations and what to do:

| What you notice | What's happening | What you do |
|-----------------|------------------|-------------|
| boss-1 seems to have forgotten earlier decisions | its context is filling; answers degrade silently | tell it to rewrite `SNAPSHOT.md` cleanly, then start a **fresh session** that resumes from it |
| The same fix keeps failing / two agents ping-pong | a loop isn't converging | it should auto-surface; if not, interrupt and tell boss-1 to stop the loop and bring you what was tried |
| An agent says "done" but it feels thin | a happy-path shortcut slipped through | ask for the gate verdicts in `review/log.md`; if they're missing, it isn't done — send it back through the debugger and both gates |
| Both gates passed but you're still uneasy | LLM review is strong, **not** infallible | use the second-terminal review board; you hold the final call — for high stakes, don't ship on gate-green alone |
| Team drifts toward "let's also build X" | the breadth trap | critics gates scope against the Charter; if it slipped, point boss-1 at the Charter's out-of-lane list and have it decline, with the reason logged |
| Cost/usage is climbing fast | too many agents awake, or loops running long | tighten the leash; tell boss-1 to cut parallelism and reserve the top model tier for checkpoints only |
| `SNAPSHOT`/logs look empty after real work | an agent skipped the write — the sync is broken | treat unlogged work as **not done**; tell boss-1 to enforce write-after-every-turn and backfill the record before continuing |
| A gate keeps blocking the same thing | the fix targets the symptom, not the cause | read the BLOCK in `review/log.md` — it names the file and the reason; make sure the fix addresses *that* |
| The team asks you the same decision repeatedly | it's parked in `decisions/needed.md` | answer it there (or to boss-1); your answer unblocks the loop |

If in doubt, the safest recovery is always the same: **read `SNAPSHOT.md`, tell boss-1 what you see,
and set a tight leash** until you're confident again.

---

## Long projects: when context fills

boss-1 tries to watch its own context — but a filling context degrades *silently* (that's why the
troubleshooting table tells you to watch for it too). When boss-1 or you notice it filling, it
**rewrites `SNAPSHOT.md` cleanly** — the current goal, what's done, what's in flight, what's blocked,
every open decision, what's next — and it's a good point to start a fresh session. The new session reads `SNAPSHOT.md` and resumes exactly. The
mission's memory is in the repo; the session is disposable. Don't push a degrading session through a
big decision — start fresh.

---

## Teaching the team (feedback becomes permanent)

When you correct the team, make the correction stick: tell boss-1 to **capture it as a lesson** in
`agent-memory/lessons/`. From then on, the gates check new work against that lesson — a repeat is a
BLOCK with your lesson cited. This is how the team gets better at *your* project over time instead of
making the same mistake twice.

---

## Changing the rules (the Charter)

The Charter is yours and only yours to change. **No agent ever edits `CHARTER.md` or any spec** — if
an agent thinks a rule should change, it routes the request to `agent-memory/decisions/needed.md` for
you. When your project's identity, non-negotiables, or scope genuinely shift, **you** edit `CHARTER.md`
directly; the whole team picks up the change on their next task. Knowledge compounds automatically;
rules change only when you decide.

---

## Cost and speed (the hibernate discipline)

- Agents **hibernate by default** — boss-1 wakes one for a single bounded task; it finishes, returns,
  and goes idle (idle costs nothing). The whole team is never awake at once.
- **Model tiers** match the job **where your coding tool supports per-agent models**: the most-capable
  tier for boss-1, boss-2, and the two gates (invoked at checkpoints); a lighter, cheaper tier for the
  workers. Rigor where it matters, affordable throughput where it doesn't.
- boss-1 keeps one or two agents active at a time and parallelizes only genuinely independent work. A
  tighter leash and the Solo Minimal pack are your levers if you want to spend less.

---

## What to expect — and what not to (the honest version)

**Do expect:** specialized roles instead of one generalist; independent review gates a single agent
skips; and memory that persists across sessions and survives context resets — so you catch more,
forget less, and work with more rigor.

**Don't expect:** an autonomous company that runs itself while you sleep. Today's tools can't deliver
reliable unsupervised multi-agent autonomy, and this doesn't pretend to. **You are the driver.** The
gates make the work rigorous, not infallible — the final call is always yours. That honesty is the
point: it's why you can trust the parts the team *does* do.

---

## Your daily rhythm, in one glance

1. Start a session with boss-1 (it reads the Charter + SNAPSHOT).
2. State the goal; set the leash (tight or long).
3. Let the loops run; the team surfaces at your checkpoints and always-surface events.
4. Answer anything in `agent-memory/decisions/needed.md`.
5. Take the reconciled result; for high-stakes work, sanity-check it from a second terminal.
6. Correct anything wrong → have it saved as a lesson. When context fills, start fresh from
   `SNAPSHOT.md`.

---

## The golden rules (the five that keep it trustworthy)

1. **boss-1 is your one contact.** You manage one agent; it manages the rest.
2. **Reviewed before it ships.** Code clears both gates (critics + security); other work clears
   critics. Either red blocks the team from calling it done — overriding a red gate is a deliberate
   call only you can make.
3. **You dispose.** The team proposes; scope, trust, spend, and ship are always your call.
4. **The memory is the source of truth.** If it isn't written, it didn't happen — and it's your receipt.
5. **Only you change the rules.** Agents never edit the Charter; lessons compound, rules stay fixed.
