# rbox status — living state snapshot

> Cross-host memory for Brian + agents. Update this doc when a release ships or
> a workstream opens/closes. Deeper context: `docs/design/*` (numbered designs),
> PR history, and per-machine Claude session memory (does not travel — this doc
> is the carrier).

_Last updated: 2026-07-09 (evening) — session: design 92 ship + follow-ups._

## Where we are

- **Version: v0.9.17** (tagged 2026-07-09). Fleet = Mac (`dev_932d7c…`, primary
  work machine) + flat-meadow/FM (`dev_de63e89a…`). Real workspace
  `ws_2b6e15da…` ≈ 128.5k files on `~/Development`.
- **The 2026-07-09 poisoned-manifest incident class is dead** (design 92,
  PR #184, v0.9.16): push verify-defer (`RBOX_SOURCE_CHANGED`), size-sensitive
  push equality (self-heals poisoned sizes), fail-closed carry, and
  stage-verify-before-displace on pull. Field-gated including a real reproduced
  poison. A heavier quarantine design was deliberately shelved at doc commit
  `5cee557` behind an evidence gate: build it ONLY if an unhealed poisoned head
  ever occurs in the field.
- **Download self-heal shipped** (PR #187, v0.9.17): transport-corrupt blob
  downloads (the Bun large-blob fault) now re-fetch up to 4× instead of
  aborting the join. Merge evidence: `GATE_EVIDENCE.md` on the PR /
  `bun run gate:dl-integrity` (main-equivalent aborts; fix heals 42/42
  injections across a 10k-file join; persistent corruption still fails loudly).
- **Menu bar app (RboxBar)** lives at `macos/RboxBar`, installed at
  `/Applications/RboxBar.app`, login item set, SwiftBar shim retired
  (preserved at `~/.rbox/swiftbar-disabled/`). v0.9.17 dropdown: severity-tiered
  states (degraded = dim line, critical = card + remedy), files-count primary,
  version footer + update-available row. Rebuild/install:
  `macos/RboxBar/scripts/bundle.sh` then copy to /Applications.
- **CLI hygiene** (PR #186, v0.9.17): `track --name` forwarded; `track` reuses
  the logged-in device identity (junk-roster root cause fixed); loud
  `⚠ RBOX_API override` stderr warning (`RBOX_API_QUIET=1` to silence).
- **Device roster is clean** (2026-07-09): junk stress-join device revoked via
  `rbox device revoke`; agents were already revoked; only Mac + FM + ephemeral
  web sessions remain. Note: auth revoke is access-only — cryptographic key
  eviction needs epoch rotation (design 22 §1.3, unbuilt).

## Recent history (compressed)

- v0.9.9–0.9.10 (07-08): perf designs 79–82 — compression, batch upload,
  worker-pool crypto, steady-state O(N²) kill. Publish 27.5→10min, Mac push
  204→54s.
- v0.9.14: design 91 head authority (push requires verified head).
- v0.9.15: watcher-degraded self-clear (generation-counted) + RboxBar native
  app + resource-bundle fix.
- v0.9.16: design 92 (above).
- Incidents 2026-07-09: two fleet write-deadlocks from one poisoned manifest
  entry (120MB then 5.3GB `p9-mirror-exec.log`). Full forensics in the design
  92 doc + `docs/design/*` lessons. **Brian: your live Dfinitiv migration log
  was moved to `~/p9-mirror-exec.log` on the Mac (writer fds survived the
  rename; still being written).** `~/Development/.rboxignore` now excludes
  `Dfinitiv/savvy-core/migration-state/*.log`.

## Backlog (ledgered, not urgent)

- Stripe annual prices for design 86 (paid-only + trial + annual, PR #159);
  design 87 agent keys (PR #160); GA4 ID blocks the A/B test — **needs Brian**.
- 5.2GB orphaned R2 blob from incident #2 (GC/retention will handle or manual
  sweep); junk `keepLocalAs` conflict copies (106-byte marker) on both hosts —
  harmless.
- Perf next poles (design 82 follow-ups): git-plan/subprocess floor,
  commit-envelope delta encoding, scan; then git cold lane, per-job crypto.
- Bun 1.3.14 release-runtime A/B; crypto-pool test isolation.
- Epoch rotation / true key eviction (design 22) — unbuilt, known ceiling.

## Standing rules (hard-won)

- Agents: always work in `.claude/worktrees/<slug>` off main, never the primary
  checkout; rebase before merging (design-number collisions happen).
- Prod D1/R2 mutations: always account-scoped, never blind — coworker
  onboarding is coming; versions must be non-breaking (read-before-write
  rollouts).
- Release flow: bump `package.json` + `CHECKED_IN_RBOX_VERSION`
  (`src/cli/version.ts`), commit `release: vX.Y.Z — …` on main, tag `v*` →
  release.yml → R2. Fleet upgrade: `curl -fsSL https://rbox.to/install.sh | sh`
  + `rbox stop && rbox start`. API deploys only on merges touching `apps/api/`.
- Poison-at-head emergency playbook: needs a skip-capable binary on ONE device
  (`RBOX_SKIP_POISONED=1` pattern, branch `heal-hotfix-poison-skip`); a
  forward-only `.rboxignore` FREEZES poison at head — delete-first, then ignore.
- Fresh-join stress loops are the highest-yield test lane (3 P0 finds in 2
  days). Poison repros must use compressible data (the size cap only fires in
  the zstd counter).
