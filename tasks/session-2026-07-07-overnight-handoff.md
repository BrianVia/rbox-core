# Overnight handoff — 2026-07-06/07 session ("~/Development E2E" sprint)

**The goal you set:** ~/Development (123k files, ~140 repos) syncs seamlessly
end-to-end with dev-build iteration, then pair flat-meadow into it (its
~/Development was backed up + removed for this).

**I am still on watch.** Background monitors are running; if the publish lands
overnight I will verify it, tag v0.9.2, and attempt the flat-meadow pairing
via `ssh via-server` (fresh materialization into the empty ~/Development —
reversible; abort criteria: any halt/conflict on either machine). Everything
below is written assuming you read it cold in the morning.

---

## 1. Morning checklist — run these first

```bash
rbox status            # inside ~/Development — want: synced, sequence ≥ 1
rbox logs --lines 50   # look for "pushed → sequence N" / any halt
```

- **If sequence ≥ 1**: first publish landed. If I haven't already done it,
  remaining steps are: tag v0.9.2 (see §5), then flat-meadow pairing (§6).
- **If still sequence 0**: check `rbox status` for a halt reason and
  `tasks/…-overnight-handoff.md` §7 (known failure modes + what each looks
  like). The most likely residual is another silent fetch black-hole
  (backlog: no-timeout post-upload POSTs — PR #114, unmerged).

## 2. What shipped tonight (all merged to main unless noted)

| PR | What | State |
|---|---|---|
| #104 | `bun run dev:install` → `rbox-dev` local binary (<1s build, `-dev+sha` stamp, nudge suppressed), docs/dev-loop.md | merged |
| #105 | Context-aware bare `rbox` (status + picker in a workspace) + **version in status header** (your ask) | merged |
| #106 | **Restore of #100 status honesty** — PR #101 had silently clobbered it via a stale-base squash; **v0.9.1 shipped clobbered** (that's why you saw red "sync halted") | merged |
| #107 | Capture's silent early bails now throw named reasons (savvy-core diagnosis tool) | merged |
| #109 | Files vanishing mid-push defer instead of killing the whole op (live repro ×2) | merged |
| #110 | **Design 71 refs-at-scale**: batched receipt redemption (kills the 45MiB-receipts-vs-8MiB-body wall), refs cap 50k→250k M-inclusive, bounded 422s, terminal halts | merged + prod-deployed (verified: redeem route 401s, not 404s) |
| #111 | Builtin ignores: `.build/ cdk.out/ __pycache__/ .terraform/ DerivedData/` + ~25 more (curated; generic names deliberately absent) | merged |
| #112 | **Design 72 nested .gitignore**: discovery pruning always-on, `respectGitignore` opt-in (untracked-only, git parity), `rbox ignore --purge` with tracked-safety refusals | merged |
| #113 | Design 73 doc: byte-level transfer progress (the silent-giant fix) — **doc only, implementation NOT started** | merged |
| #114 | Backlog: no-timeout post-upload POSTs (the 110-min wedge) + SIGTERM-mid-multipart + condemned-blob resume | **OPEN — checks never registered; merge it** |
| #115 | **GC phase-1 grace 1h → 24h** (the cron was eating the in-flight publish) | merged + auto-deployed |
| — | v0.9.2 bump (package.json 0.9.2, version.ts, CHANGELOG) direct on main (fb42158) | on main; **TAG NOT PUSHED yet** (deliberately — §5) |
| — | Receipts-flow flaky test fix (tamper could be a no-op 1/64 runs) | direct on main (6410390) |

Also: design-number collision again — another agent took 70 (Workers Cache),
mine renumbered to 71; check `docs/design/` before numbering, always.

## 3. The five walls your first publish hit (all diagnosed, all addressed)

1. **Receipts body cap** (found by codex design review, confirmed live 21:59Z):
   commit sent ALL receipts inline; cold 123k publish ≈ 45MiB vs 8MiB cap →
   `body_too_large`. Fixed by #110's batched `receipts/redeem`.
2. **Refs cap**: 123k unique refs vs `MAX_REFS_PER_COMMIT=50k` (validated at
   12k, guessed above). Raised to 250k with derived budget-math tests (#110).
3. **Vanishing files**: one deleted worktree file killed the entire push
   (twice, live). Now defers per design 38 (#109).
4. **Fetch black-hole**: post-upload POST hung 110 min, 0% CPU, zero sockets —
   promise never settled. Restart recovered; durable fix = timeouts on those
   POSTs (**backlogged in #114, not yet implemented — the most likely thing
   to bite again overnight**).
5. **GC vs first publish**: hourly phase-1 prune, 1h grace, zero commit roots
   → marked **71,742 grants** as garbage mid-upload → forced full re-upload.
   Fixed: marks deleted on prod D1, grace → 24h (#115, deployed).

Plus: savvy-core's "capture returned nothing" (5 days old) died with the old
daemon process — captures fine on every cycle since 22:19Z; #107 names any
recurrence. HEAD is still case-drifted on disk; #102's normalization handles it.

## 4. Live state when I wrote this

- Daemon: `rbox-dev 0.9.1-dev+b2ad75a` pid 28782 (started 02:29Z after the
  GC rescue), mid-cycle: encrypt phase (~129k files — first publish
  re-encrypts everything each attempt; backlog candidate: cache encShas
  across attempts).
- The 10GB `Personal/Medicaid-provider-spending/medicaid-provider-spending.csv`
  is UPLOADED + granted (survived the GC purge of marks — blobs were never
  deleted, only grants marked; marks now cleared). You said you don't need it
  synced: **after** the first publish lands, consider
  `rbox ignore Personal/Medicaid-provider-spending/` — receivers won't pull
  it (pull-side ignore filter), and it stops being re-hashed. It stays in
  quota until a purge; `rbox ignore --purge` (new, #112) can remove it —
  dry-run first.
- Prod: design-71 server live; GC grace 24h live; account
  `acct_b4e0b8146b8535d7` has 0 candidate marks (verified post-delete).
- Watchers running: daemon.log monitor, sequence-poller (fires when
  sequence > 0), log-line watcher.

## 5. v0.9.2 release — one step left

Version bump is already on main (all three spots: package.json, version.ts,
CHANGELOG). **Deliberately untagged** until your workspace actually publishes
(your machine is the release smoke test). To ship:

```bash
git fetch && git tag v0.9.2 <main-sha> && git push origin v0.9.2
# release.yml builds/signs/publishes; verify: curl -s https://api.rbox.to/version
```

v0.9.2 carries: design-71 client, #106 status-honesty restore, #107, #109,
#111, #112, front door, dev builds. (I will do this overnight if the publish
lands and CI is green.)

## 6. Flat-meadow pairing (the last mile)

Preconditions: sequence ≥ 1 and steady-state clean on the Mac; v0.9.2
published (flat-meadow installs from the release manifest).

```bash
# on the Mac
rbox pair                       # prints a one-shot token, 10-min TTL
# on flat-meadow (ssh via-server) — ~/Development was backed up + removed
curl -fsSL https://rbox.to/install.sh | sh
rbox connect                    # paste token; then pick ws_a945756e… ("~/Development")
```

Then verify: file spot-checks byte-identical, `git -C <repo> fsck` on a few
materialized repos, `rbox status` synced on both, live-edit propagation both
directions. Note the linked-worktree pointer skips are BY DESIGN (12 skips,
design 68) — worktrees rematerialize via `git worktree add` on the new host,
they don't sync as pointers.

## 7. Known failure modes if it's still stuck in the morning

- **0% CPU + no activity writes + no sockets** → fetch black-hole again
  (§3.4). `rbox-dev stop`, `kill -9` if it lingers (SIGTERM gap is
  backlogged), `rbox-dev start`. Grants are durable; restarts are cheap now.
- **Huge re-upload again** → check marks:
  `cd apps/api && bunx wrangler d1 execute rbox-prod-db --remote --env production --json --command "SELECT COUNT(*) FROM blob_ref_candidates WHERE account_id='acct_b4e0b8146b8535d7'"`
  Should be ~0 pre-publish. If large again, something re-marked (grace deploy
  didn't take? check Workers Builds deploy log for #115).
- **Halt: too_many_refs / sync blocked (red)** → shouldn't happen (123k < 250k
  cap) — if it does, the count in the message is the diagnostic.
- **HTTP 500s** → two isolated transients so far tonight (20:33Z, 02:26Z),
  never repeated; a run of them = check `wrangler tail rbox-prod-api`.

## 8. Queued next (in priority order, my recommendation)

1. Merge #114 (backlog doc; checks glitch — re-run or admin-merge).
2. **Implement the post-upload POST timeouts** (the #114 backlog entry) —
   the only remaining known wedge class on the push path.
3. Implement design 73 (byte progress) — doc merged + codex-reviewed v2;
   implementation was deliberately queued behind design 72 (shared files),
   which is now merged. Ready to dispatch.
4. Design 69 §3.4 (daemon publishes counts snapshot; <300ms status).
5. First-publish encrypt cache (encShas persisted across attempts — tonight
   re-encrypted ~17GB per attempt, pure CPU waste).
6. Your decisions pending: medicaid-CSV ignore (§4); `respectGitignore` on
   ~/Development (ships OFF; enabling is safe — deletes nothing without
   --purge); marketing-site M1–M5 copy fixes (rbox-home-page repo, untouched).

## 9. Session lessons already written to permanent memory

Stale-base squash clobber #3 (v0.9.1 shipped without its headline feature —
file-list review is now doctrine), design-number collisions (check before
numbering), nettop bytes are per-connection not monotonic, merge commands must
be GATED on CI state (I chained one unconditionally tonight; docs-only diff,
no harm, won't recur), and the full five-wall map of giant-workspace first
publishes.

---

## OVERNIGHT RESULTS (appended as they happened)

- **03:58:32Z — SEQUENCE 1 PUBLISHED.** 139,052 files. Sole deferral: the
  medicaid CSV (still-changing churn defer) — then ignored per your call
  (`Personal/Medicaid-provider-spending/` in .rboxignore; never committed, so
  nothing carries).
- **v0.9.2 tagged + released + verified** (manifest, sha match, binary
  self-report) — you said go. Your installed CLI upgraded 0.9.1 → 0.9.2 via
  the signed path; daemon restarted onto the release binary.
- **04:04:32Z — SEQUENCE 2 (steady state):** ~30s cycle, 3 repos captured /
  118 carried / 23 designed skips / 0 deferred. Design-72 discovery pruning
  observed live ("gitignored by discovery pruning — carrying base" for the
  GRDB dependency clone).
- **Flat-meadow pairing IN FLIGHT:** upgraded 0.6.8→0.9.2, re-enrolled via
  pair token (device dev_de63e89a…), joining ws_a945756e into its empty
  ~/Development (`rbox init --workspace … --no-interactive`, pid 864261,
  log: `~/rbox-join.log` on flat-meadow). Materializing 139k files +
  121 repos; monitored every 5 min. On completion I verify (byte spot-checks,
  git fsck samples, two-way propagation) and start its daemon + autostart.
- **~04:20-04:35Z — FLAT-MEADOW PAIRED, GOAL COMPLETE.** Join materialized
  109,300 files + 120 repos into its empty ~/Development; its rbox-core
  checkout is at tonight's main tip and savvy-core HEAD matches the Mac.
  Daemon started + autostart enabled. Two-way propagation verified live —
  including the conflict path: a divergent edit I engineered was preserved as
  a designed `.conflict.txt` copy, content converged both ways. Test files
  cleaned up.
- **New bug found + worked around (backlogged, on main):** the Mac daemon's
  e2ee context went stale when flat-meadow's admission changed the roster —
  every daemon push failed "E2EE required" (×10) while foreground `rbox sync`
  worked perfectly. Restart heals; the fix (in-process context rebuild on
  that error class) is the top backlog item alongside the post-upload POST
  timeouts. Watch for it if you add more devices before it's fixed.
- **Morning residuals to eyeball:** (a) 2 repos were "pending" on flat-meadow
  at join (`Personal/blog` among them) — should have materialized on later
  pulls: `ssh via-server 'git -C ~/Development/Personal/blog log --oneline -1'`;
  (b) savvy-core re-bundles every ~2 min while Conductor agents commit there
  (design 53's measured trigger — expensive but correct); (c) both daemons
  should show clean `rbox status` on both machines.

**Final sequence count when I signed off: 6+. Both machines live, synced,
autostarted. The funnel's device-2 story is real now.**

## POST-GOAL HOTFIX (04:38–05:05Z) — v0.9.3

After the goal completed, the steady-state watch caught **v0.9.2's daemons
dying within minutes of start**: the design-72 workspace-config reload rebuilt
the daemon's cfg from workspace.json on the first safety tick, dropping the
runtime-attached `encrypted`/`kek`/credential-`remoteUrl` — every subsequent
push failed "E2EE required" while foreground sync worked. (My first theory —
roster staleness from flat-meadow's admission — was wrong; the backlog entry
on main is corrected.) Fixed in **PR #116** (reload moves only
`respectGitignore`; regression test pins the runtime fields), released as
**v0.9.3**, both machines upgraded via the signed path and soak-verified:
zero errors past many reload ticks, Mac publishing (seq 13), flat-meadow
publishing (seq 14) and live-tracking at 11s latency.

**Final state at sign-off: both machines on v0.9.3, two-way live sync,
sequence 14, all watchers armed, zero known active issues.**

**Overnight transient-500 log (all self-healed within a retry tick):** 20:33Z,
02:26Z, 06:01Z, 08:00Z. The last two landed at :00–:01 — the hourly GC cron's
window (its per-account sweep reads every blob_refs row while commits run
accounting txns). Two of four is suggestive, not conclusive; if the top-of-hour
correlation continues, the cheap probe is `wrangler tail rbox-prod-api` across
one hour boundary, and the likely fix is jittering the cron's account sweep.

---

## CAPSTONE RE-TEST — COMPLETE (2026-07-07 afternoon)

Teardown: both machines untracked (Mac files intact), workspace + keys
deleted server-side, all 64,558 remaining entitlements condemned + usage
zeroed (R2 objects queue for leisure-purge via gc_candidates; entitlement
wipe forces genuine full re-upload — identical work profile to empty R2).

**Measured, on v0.9.4/5 (baselines = last night):**
- Fresh first publish of ~/Development: **23 min** (1,381s), one attempt,
  zero walls, live dual-fraction progress throughout ("uploading
  92,464/92,465 · 4.9/4.9 GiB"). Was: ~8 hours through five walls.
- Flat-meadow full rematerialization: **16 min** (968s). Was ~1.5h.
  Already inside the founder's ~20-min clone-parity bar pre-compression.
- Steady state: increments live in prod (rbox-core gitcap = **199KB** vs
  tens-of-MB full bundles); propagation Mac→flat-meadow ~14s; both
  design-69 (`local` slot) and design-73 (bytesDone) observed in
  activity.json in production.
- Two-way sync verified (marker + interleaved sequence history 1→7).

**Found + fixed during the capstone:** resolve-undo (REUC) index
extension made any repo with old conflict residue permanently
unsyncable to receivers (Personal/blog, both workspace generations —
source fsck clean, receiver fsck "invalid sha1 pointer in resolve-undo"
→ eternal rollback). Fixed both sides (#129), shipped as **v0.9.5**,
and blog healed on flat-meadow with NO fresh capture (apply-side clear).

**Open follow-ups:** task #23 materialization parity (base-case benchmark
→ compress-before-encrypt design — the founder's adoption bar); status
falls back to the 9s path whenever the tree is unsettled (spec-correct;
amendment idea: serve last-settled counts + live qualifier); Phase-1A
git-apply pool gate decision once a measured pull-phase split is
collected (RBOX_METRICS was off for the rejoin — re-measure); GC-sweep
D1 contention (paginate the mark read); R2 leisure purge of ~70k
condemned objects.
