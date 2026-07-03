# Security pack — log (append-only)

> The Security/Audit pack (threat-modeler, pentester-advisor) records its work here: threat models,
> test plans, authorization/scope state, and interpreted results. Newest at the bottom. Write fully;
> read selectively via the `###` headers. Entry format is in `../README.md`. Settled threat models
> are distilled into `threat-models.md`.
>
> Note: this pack **advises**; it never runs live attacks and never advises on active testing without
> the owner's explicit, documented authorization. The authorization state for any active test lives in
> these entries and in `threat-models.md`.

---

<!-- Example entry (delete once real work begins):

### [2025-01-15 11:00] threat-modeler — attack surface: public API
- **Task:** model the threats against the public API before build.
- **Did:** mapped assets, trust boundaries, entry points, and data flows; enumerated threats
  (STRIDE-style) and rated by likelihood/impact.
- **Result:** 6 threats, top 2 = broken object-level auth (IDOR) and injection at the search param;
  each tied to a concrete mitigation. Written to `threat-models.md`.
- **Refs:** `threat-models.md` § "public API".
- **Next / who needs to know:** dev-head to design against the top 2; pentester-advisor to build the
  test plan (authorization state: none on record — planning/passive only until the owner authorizes).

-->
