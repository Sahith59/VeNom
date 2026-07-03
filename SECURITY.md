# Security Policy

Venom takes security seriously — it ships an internal `security` review gate for a reason, and it
holds itself to the same bar.

## What Venom is (so you can scope a report)

Venom is a scaffolding CLI. Running `npx venomkit init`:

- writes Markdown agent specs, a memory scaffold, and a permission profile into your project, and
- records an install manifest at `.venom/install.json`.

It runs **no code of its own beyond those file writes**, makes **no network calls of its own**, and
has **zero runtime dependencies**. The agents it installs run inside *your* coding tool, under *your*
control — Venom does not execute them.

The generated `.claude/settings.json` is intentionally conservative: it allows read operations, asks
before impactful ones, and **denies** dangerous ones (e.g. `git push`, `git reset --hard`, `rm -rf`,
`curl`/`wget`, and reading `.env` or secret files). If you find a way that profile is unsafe, that is
in scope.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it privately:

- **Preferred:** open a private advisory via GitHub —
  [**Report a vulnerability**](https://github.com/Sahith59/VeNom/security/advisories/new)
  (the Security tab → "Report a vulnerability").
- **Or email:** **sahith0904@gmail.com** with `SECURITY` in the subject line.

Please include:

- what the issue is and why it's a security problem,
- steps to reproduce (a command, a repo layout, a crafted input),
- the version (`npx venomkit --version` or the `version` in `.venom/install.json`), your OS, and your
  Node.js version, and
- any suggested fix, if you have one.

## What to expect

This is currently maintained by one person, so responses are best-effort rather than an SLA — but
you can expect:

- an acknowledgment that your report was received, as soon as reasonably possible;
- an honest assessment of whether it's a vulnerability and how it will be handled;
- credit for the report if you'd like it, once a fix ships.

Please give a reasonable window for a fix before any public disclosure, and coordinate the disclosure
timing so users can update first.

## Supported versions

Venom is pre-1.0. Security fixes land on the latest `0.x` release; there are no back-ported patch
branches yet.

| Version | Supported |
|---------|:---------:|
| latest `0.x` | ✅ |
| older `0.x`  | ❌ (please update) |
