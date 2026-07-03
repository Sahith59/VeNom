# Dev team — distilled architecture

> The Development team's **settled** knowledge: the architecture, the load-bearing conventions, the
> "why" behind them — without the log noise. dev-head curates this. An agent reads this (not the
> whole log) to understand how the system is built before adding to it. When a decision here is
> load-bearing, it should also have an ADR in `../adr/dev/`; this file is the readable summary, the
> ADR is the immutable record.

## System shape
_(The high-level architecture: the main components and how they fit. Filled in as the project takes shape.)_

## Conventions that are settled
_(Naming, error handling, data access, testing bar — the patterns builders must follow. Point to the ADR where one exists.)_

## Invariants (from the Charter, made concrete in code)
_(How each Charter non-negotiable shows up as a concrete rule in this codebase — e.g. "the verdict logic lives in one function, never duplicated." Filled in per project.)_

## Known constraints / things to revisit
_(Deliberate limitations, deferred work, and where the "why" lives.)_
