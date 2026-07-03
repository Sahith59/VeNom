# Dev team — log (append-only)

> Every meaningful action by the Development team (dev-head, developer-1/2, testing, debugger,
> design, and — in the Data/ML pack — data-engineer, ml-engineer) is appended here, newest at the
> bottom. Write fully after every turn; read selectively by scanning the `###` headers. Entry format
> is in `../README.md`. Settled architecture is distilled into `architecture.md` so this log stays a
> record, not a knowledge base.

---

<!-- Example entry (delete this once real work begins):

### [2025-01-15 14:30] developer-1 — auth: session token rotation
- **Task:** rotate session tokens on privilege change (definition of done from dev-head).
- **Did:** added rotation on role change + logout-all; covered the concurrency edge where two
  requests rotate at once.
- **Result:** implemented; testing green; awaiting both gates.
- **Refs:** `src/auth/session.ts`; builds on ADR dev/0002 (single session store).
- **Next / who needs to know:** testing to add the concurrent-rotation case; security to audit for
  fixation.

-->
