# Retro — the engine sprint (2026-07-13 → 07-14)

One continuous ~30-hour session: nine releases, twelve designs touched, every
change adversarially reviewed, built by codex, gated by CI, shipped to the
fleet, and measured in the field. This document is the durable record; current
state lives in STATUS.md, per-design detail in the REVIEW-* ledgers.

## The scoreboard (all field-measured, same fleet)

| Metric | Sprint start | Sprint end |
|---|---:|---:|
| Greenfield init → workspace usable | 578s | **227s** (files-first) |
| Greenfield init → fully complete | 578s | 336s |
| Edit → applied on another machine | 41.5s (manual) | **~17s** (WS notify) |
| Server commit admission | 6,653ms avg | **281ms** (enforce) |
| Push wall, mid-size publish | 39.2s | **31.9s** (drain fix, −19%) |
| Branch switch → other machine follows | never (deferred silently) | **71s round-trip** (design 116) |
| Crypto pool in release binaries | **never ran** (Bun compile bug) | 16/10/14 workers live |

## Releases

- **v1.3.0** — files-first default-on; init identity/exit fixes; workspace
  purge route; concurrency knobs.
- **v1.4.0/1.4.1** — fill-v2 batch dispatch (records verdict: 32, evidence);
  upload-time draining; modularized engine (113: six giants → ~24 modules +
  CODEMAP); 102 enforce.
- **v1.4.2** — the Bun 1.3.5 `--compile` import-attribute bug: every prior
  release binary silently ran inline crypto AND hung one-shot commands.
  Pool restored; Bun pinned 1.3.14; compiled-exit regression test.
- **v1.5.0–1.5.3** — blob packing reader path + pack accounting (writer
  opt-in after the field verdict below); release-gate test-hygiene fixes.
- **v1.5.4** — the 111 drain field gap: E2eeRemote never forwarded
  receiptPort, so draining shipped default-on but inert. Fixed + compile-time
  wrapper/transport parity guard. −19% push wall.
- **v1.6.0** — design 116: checkout follows sync. Per-ref worktree holds +
  OID-equality no-op (the Mac-freeze class is extinct); derived-receipt
  oracle; two-phase rollback-only checkout journal; drift visible in status/
  --json/daemon/shell/menu-bar; `rbox git resolve` (show-me + take-theirs).

## Evidence-driven verdicts (things the data decided)

- **114 blob packing: mechanics perfect, thesis expired.** 20,408→45 R2 PUTs,
  zero errors — and ~16% slower, because earlier wins had already moved the
  wall to the redeem/commit tail and pack receipts redeem at 2x. Writer stays
  opt-in; re-hearing owed on a cold-join (download) test. The infra is live
  and its shadow GC is soaking real packs.
- **109 auth grants: parked as perf** (gate-0: ~89ms/request), **shipped as
  hygiene** (bearer always on the wire; grant = server-side verification
  fast-path only).
- **112 records cap: 64 lost to 32** in the matched-cell sweep (−7%); fill-v2
  won (−14.1%). Defaults follow the data.
- **Slots, auth, records** — three client-side swings at the upload wall, all
  disproven by measurement, which triangulated the real levers (tail costs,
  then packing-for-different-workloads).

## Incidents (all contained, all productized)

1. Agent worked in the primary rbox-synced checkout → playbook rules + the
   later realization that the coordinator's own cwd was the repeat offender.
2. `git add -A` swept 400k lines of worktrees into a release commit →
   reverted; .gitignore + enumerate-paths rule.
3. The Mac's git plane frozen 3 days by a stale linked worktree at an
   identical OID → became design 116's Phase-0, then the fix, then the 71s
   proof.
4. CI's identity-less git exposed a real fresh-machine fatal (stash reflog
   publication) → synthetic ident fallback; caught before any user existed.

## What remains (deliberately small)

- One hygiene cycle: §11 flake determinism, grant-overlap un-skip, sweep.sh
  fp-grep, record the pack rollback-floor version id.
- Evidence-gated parks with named triggers: packing cold-join re-hearing,
  115 crypto (crypto-bound host on a >200Mbps pipe), 110 conditional, 98
  pipeline revisit, keep-mine resolve verb.
- Product surface: admin cockpit metrics roadmap + landing-page improvements
  (briefs in rbox-admin/docs and rbox-home-page/docs, synced fleet-wide for
  codex execution).

## The one-line lesson

Measure before believing, review before shipping, ship before polishing —
and when the product's own dogfood bites, that bite is the roadmap.
