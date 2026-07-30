---
name: simplify-codebase-primitives
description: Reduce codebase complexity into a small set of deep, behavior-preserving Modules with clear ownership and complete Interfaces. Use for every non-trivial coding, design, refactor, architecture, or code-review task; for CLI/daemon/runtime work; when code feels tangled, branch-heavy, over-modeled, or difficult to understand; and when identifying safe deletion or challenging incidental requirements.
---

# Simplify Codebase Primitives

## Prime directive

Preserve supported behavior unless the user explicitly approves a product
change. Reduce complexity by reducing concepts, authorities, branches,
Interfaces, modes, and cross-Module knowledge—not by distributing the same
complexity across more files.

Prefer the smallest coherent set of deep Modules: narrow Interfaces hiding
substantial implementation. File splitting is not architecture.

Use these terms precisely:

- **Module:** owns a coherent domain responsibility and hides decisions.
- **Interface:** the smallest complete operations callers need.
- **Seam:** justified variation between real implementations or policy.
- **Adapter:** translates an external surface into a Module Interface.
- **Depth:** implementation complexity hidden behind a small Interface.
- **Locality:** one behavior can be understood and changed mostly in one place.

## Non-negotiable rules

1. Preserve commands, outputs, protocols, safety, crash recovery, compatibility,
   performance fast paths, and active migrations/readiness by default.
2. Give every invariant, state transition, durable record, and physical effect
   one explicit owner. Distinguish physical-effect recovery from logical
   checkpoint authority.
3. Keep CLI, daemon, HTTP, UI, and background-loop code as Adapters. They must
   not independently reconstruct domain orchestration.
4. Introduce a Seam only for real variation. Do not add ports, plans, receipts,
   capabilities, wrappers, or identity echoes that merely relay one in-process
   call.
5. Reject move-only refactors that improve navigation but do not reduce the
   number of concepts a maintainer must understand.
6. Treat each new flag, mode, boolean, fallback, sidecar, queue identity, and
   special-case branch as a new requirement with an owner and deletion
   condition.
7. Keep fast paths and their correctness backstops unless measured evidence and
   explicit product approval permit a change.
8. Never call active migration or rollout code dead compatibility.

## Workflow

### 1. Establish the protected contract

Before proposing or writing code:

- Read repository rules, ownership maps, relevant designs, support windows, and
  migration plans.
- Trace actual entry points rather than trusting filenames or comments.
- Write a protected-functionality ledger covering supported behavior,
  invariants, formats, crash semantics, performance, and degraded modes.
- Separate four categories:
  - supported functionality;
  - active migration/rollout work;
  - deprecated functionality awaiting an explicit retirement gate;
  - potentially unreachable implementation.

When uncertain, protect the behavior and label the uncertainty.

### 2. Map conceptual complexity

Inspect:

- entry points and call paths;
- import cycles and dependency direction;
- duplicate orchestration across Adapters;
- state and transition authorities;
- branch-heavy orchestrators and cross-cutting flags;
- public types, plans, ports, receipts, and wrappers;
- large files and Modules;
- environment variables and rollout switches;
- tests that reveal the true supported contract.

Use sizes and counts as evidence, not targets. A 1,500-line deep Module can be
better than fifteen shallow Modules exposing its protocol.

### 3. Design the primitives

For every proposed Module, state:

| Field | Requirement |
|---|---|
| Owns | One coherent behavior or authority |
| Must never own | Adjacent responsibilities that would recreate coupling |
| Interface | A few complete operations, not protocol phases |
| Absorbs | Existing orchestration or shallow Modules made internal |
| Evidence | Why the Module improves Depth, Leverage, and Locality |
| Validation | Differential tests at the Interface |

Prefer:

- one composition root for shared mutation rules;
- one owner for each durable transition;
- opaque internal plans/evidence instead of leaked protocols;
- pure decisions separated from effects;
- operation-scoped capabilities minted only at the mutation boundary;
- one observation reused by all consumers;
- one traversal or external effect when the current flow already shares it.

### 4. Delete safely

Keep deletion separate from feature retirement.

A file becomes **proven dead** only after attaching evidence for:

- commands, subcommands, flags, and aliases;
- static and dynamic imports;
- package exports and embedding consumers;
- build, bundle, generated-load, and TypeScript inventories;
- scripts, hooks, CI, installers, and external automation;
- documentation and operational runbooks;
- supported persisted/wire formats and release windows;
- an owner check.

Static reachability alone is insufficient. If deletion would make complexity
reappear in multiple callers, absorb the behavior into its owning Module
instead of deleting the abstraction.

### 5. Challenge incidental requirements explicitly

Maintain a separate requirement-challenge ledger:

| Requirement | Complexity cost | Usage/support evidence | Recommendation | Decision needed |
|---|---|---|---|---|

Be aggressive about questioning requirements that multiply every Module, but
never silently remove them. Until the product decision is explicit, preserve
them behind the proposed Interface.

### 6. Migrate in behavior-preserving slices

Default sequence:

1. Characterize current behavior and performance.
2. Delete only proven-dead code.
3. Introduce one primitive behind the existing surface.
4. Route one caller at a time through it.
5. Differentially compare old and new paths.
6. Remove the old path only after equivalence.
7. Update the ownership map when ownership changes.

Do not mix a structural refactor with unapproved product cuts.

### 7. Validate the architecture

Use the strongest relevant evidence:

- old/new differential fixtures;
- crash injection around every durable or external effect;
- foreground/daemon and present/absent/broken-runtime matrices;
- current/legacy format and released-old/candidate binary compatibility;
- compiled CLI and packaging smoke;
- import/dependency direction gates;
- supported-runtime typecheck and tests;
- checked-in p50/p95 performance baselines and A/B gates;
- the repository's real rig or local fleet build.

Record baseline failures honestly. Do not weaken safety or delete behavior to
make an incapable environment green.

## Always-on diff review

Before approving any non-trivial change, ask:

- Did concept count fall, or did the diff merely move code?
- Does one Module clearly own the new behavior and its state?
- Did an Adapter gain orchestration or policy?
- Did the change add cross-cutting branches, modes, or fallback?
- Is every new abstraction earning its keep through Depth or real variation?
- Can a caller complete its job without knowing internal protocol phases?
- Is physical-effect ordering atomic with the logical transition it proves?
- Did the change duplicate a scan, traversal, remote call, or state read?
- Is deletion backed by the full reachability/support proof?
- Are active migrations and fast paths still protected?
- Would removing the new Module make complexity reappear in several callers?

Treat structural regressions as blockers even when tests pass.

When also running `thermo-nuclear-code-quality-review`, apply both standards.
Line count is a warning signal, not the goal: do not split a cohesive deep
Module into shallow pass-through files merely to stay below a threshold.

## Required audit output

For codebase-wide or architectural work, deliver:

1. verdict and structural diagnosis;
2. protected-functionality ledger;
3. measured complexity map;
4. proposed Module/Interface/ownership map;
5. reachability candidates with proof state;
6. requirement-challenge ledger;
7. ranked migration cycles;
8. differential, crash, compatibility, and performance gates;
9. explicit statement of what is not approved for deletion or retirement.

Prefer a small number of high-leverage primitives and deletion cycles over a
large catalog of local cleanup suggestions.
