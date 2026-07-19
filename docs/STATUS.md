# rbox status — living state snapshot

> Cross-host memory for Brian + agents. Update this doc when a release ships or
> a workstream opens/closes. Deeper context: `docs/design/*` (numbered designs),
> PR history, and per-machine Claude session memory (does not travel — this doc
> is the carrier).

_Last updated: 2026-07-19 (day — "the state-plane reckoning") — **TWO RELEASES (v1.7.5 + v1.7.6, both live + field-verified) + DESIGN 161 SHIPPED + DESIGN 163 PROGRAM LAUNCHED + CI FLAKE CLASS KILLED (3 rounds).** Founder's fresh-install validation found the day's arc: (1) **reset-budget crash-loop** (59 MB state × 52 multiplier vs fixed 4 GiB budget minus warm RSS → daemon dead on a 96 GB Mac) → 161 fast-fix SAME DAY in v1.7.5 (machine-scaled budget max(4GiB,min(totalmem/4,32GiB)) + Linux cgroup caps + teachable error; 52× multiplier deliberately kept per adversarial review — state-shaped multipliers violate 138's fail-closed contract). (2) **12.2s rbox status** → root-caused to the unsettled-daemon fallback (steady-state 0.84s; 162's ambient-first draft DEMOLISHED by review — trusted path already skips scans, dircache already existed behind RBOX_SCAN_PRUNE — parked). (3) **daemon RSS ratchet 2.95→6.6 GB** + **59 MB state rewrite every 30s in steady state** → root-caused to an undefined-vs-{} guard bug (#349) + per-cycle full-blob serialize; BOTH fixed in v1.7.6 (Layer A scan cache default-on with watcher-gated pruning + Darwin bulk recording #348; steady-state write elision #349). Post-upgrade Mac field proof: dc:hit walked=0, no-op cycles save NOTHING, RSS restart 2.63 GB. **DESIGN 163 (state plane → bun:sqlite) is now the flagship program** (founder: park nothing, "full boar", modularized verticals): r1 review = 13 findings/5 CRITICAL (transactions cannot cover 138's multi-artifact choreography; hidden full-manifest materializations negate the memory win; migration/downgrade holes; integrity_check ≠ state witness). v2 KEYSTONE RULING committed (branch 163-v2): file-swap kept at ALL 138 boundaries with a candidate .db (byte-hash witness survives at-rest), WAL transactions only between commit points, WAL-sidecar-present = new crash-window rows, VACUUM INTO for quarantine. RESEARCH-138-BOUNDARIES.md (401-line extraction) on the branch; next: full row table → engine cursor architecture → migration state machine → schema mapping, each through adversarial review. **CI hardening trilogy**: #346 anti-affinity units, #352 suite-wide 3x sweep, then the model correction — subprocess-storm tests get 120s CEILINGS because starved runners inflate 30-60x regardless of local runtime (papercut: size ceilings for the worst runner). Regress-in-CI is LIVE (RBOX_DEV_BOOTSTRAP secret set; maiden run green; report-only, src-filtered, ~5min — founder may demote to nightly). **158 U1 (mint-account) BUILT** (real first-login path; Clerk key journey: quotes → rotated key → working; dev-worker __absent-azp__ sentinel shipped #351): awaits ONE founder dashboard edit (append ,__absent-azp__ to dev worker CLERK_ALLOWED_ORIGINS) then live mint→burn proof. Fleet: Mac on 1.7.6 (only host with the new identity; desktop+FM still bare by founder intent). Pending founder: dashboard edit; regress cadence call; 163 v2 continues next session._

_Last updated: 2026-07-19 (pre-dawn wrap) — **EVERYTHING MERGED: #336 picker + #339 CI papercuts + #340 front-door v2 all on main; next-release candidate complete.** Founder's bedtime findings same-night fixed (#340): (25) "plan unavailable" on fresh pro device = cache-only brief identity — front door now does ONE bounded 2s best-effort fetchAccountSummary on a cold cache (seeds the shared profile cache; the parked identity-cache self-heal is UNPARKED and shipped for the front door); (26) founder menu order — [Sync now + Start background syncing | Pause syncing] → Set up a new workspace → Pair another device → View usage → View logs → Exit; orchestrator restored Start-background-syncing (codex cut dropped it; founder ratified keeping Pause). #339: `bun run guards` (CI guards runnable locally — fixture-tested) + path-filtered `web · check + build` PR job (merge-base git diff detection, npm 10.9.2). #336 needed one branch-update after runner-starvation timeouts (release build contention) — second CI clean. Session velocity data (founder asked): 15 PRs merged + 1 CLI release + 1 prod promotion + 2 designs drafted→ALIGNED (159: 8 rounds ~3h; 160: 4 rounds <1h) + 159 implemented/merged same night; 54 commits on main in 26h; ZERO codex correctness re-dispatches across ~10 implementation dispatches (self-run tests = biggest cycle saver); auto-merge is attention-saving not wall-clock-saving (watchers were already fast, but killed-watcher failure class is gone); `bun run test:affected` went UNUSED tonight (adopt next session — ~3min × ~8 full gate runs left on the table). Morning queue for Brian: v1.7.4 fresh-install validation, then call the next release (picker + front door + guards ride it)._

_Last updated: 2026-07-19 (early AM) — **v1.7.4 RELEASED ("a first sync you can watch") + BRANCH RULESET LIVE (PRs required on main, native auto-merge) + 159 IMPLEMENTED (PR #336, rides the NEXT release).** v1.7.4 = the validation-audit CLI batch: byte progress with MB/s + stability-gated ETA (#329), seven onboarding polish items (#328), set-up-another-machine after setup (#332), RBOX_DEBUG telemetry gating (#333), honest gitignore copy + !.env secrets teaching (#335, founder-decided relabel path). Tag a638f2e; release workflow green; manifest live (3 artifacts). Founder-sequenced: #336 (typeahead picker, design 159 implemented + full-scrutiny reviewed, ALL gates green incl. regress 11/11 with the picker driving flows; one red CI round from the @inquirer single-import guard — widget moved into prompt.ts, pure logic stays in directory-picker.ts) was DELIBERATELY held out of 1.7.4, auto-merge re-armed post-tag. **Process changes: `main` requires PRs now (even docs — owner bypass removed by founder); the nine required checks exclude Cloudflare Pages (false-fails); `gh pr merge --auto --squash` at PR-open replaces hand-rolled merge watchers.** Design 160 (gitignore preview) ALIGNED + PARKED with founder's future-evolution idea recorded (suggest `.rboxignore` inverses from secret-shaped NAMES, existence-only). No prod promotion needed (zero apps/ delta since 1d68d35). Fleet note: hosts still wiped from validation; `~/rbox-dev` staged binaries now superseded by the real 1.7.4 installer. Founder pendings: fresh-install validation pass on 1.7.4 (`curl -fsSL https://rbox.to/install.sh | sh`), #22/#3 unchanged, 155 + 158 parked._

_Last updated: 2026-07-19 (overnight — founder-authorized dispatch run) — **DESIGNS 159 + 160 BOTH ALIGNED (implementation NOT dispatched — founder's call) + PR #334 papercut fixes MERGED.** **159 typeahead directory picker** (validation #8): ALIGNED at v8 after EIGHT codex adversarial rounds (12→5→4→1→1→1→3→0 findings) — final shape: custom `@inquirer/core` prompt (stock search widget provably can't express it), single state tuple (raw string + highlight) with a staged lexical→expanded→resolved projection, pinned `use "<input>"` row preserving the type-nonexistent-path→create-confirm contract, Enter/Tab split (highlight resets to use-input row on edit; Tab completes best-ranked child), blocking readdirSync (no async source = no race class), lifetime-memoized listings. Two of the eight rounds were self-inflicted: silent no-op `str.replace` folds left stale contradictory text the reviewer attacked (papercut logged; fix = whole-section replacement + grep-verify). **160 gitignore sync preview** (validation #9): ALIGNED at v5 after 4 rounds — preview is an ACTION row that re-prompts (never a third policy), decisions come from the production resolver via a new `readOnly` + budgeted discriminated-result build mode, four-set truth-table model including the INVERSE set B′ (tracked root-ignored files sync under "skip gitignored" but NOT under "sync everything" — tracked protection + legacy layering), per-policy ancestor-prune walker, fail-closed on budget cap. **⚠ FOUNDER DECISIONS OPEN: (1) design-160 surfaced that the shipped option-2 label "Sync gitignored files too" overpromises TODAY (root .gitignore respected in both modes; relabel vs engine change — design assumes relabel); (2) implement/park order for 159 (M-L) and 160 (M); (3) branch-protection ruleset (exact recipe in session transcript) to enable native auto-merge.** **PR #334 MERGED (papercuts):** `release.ts --dev` (honest `<ver>-dev+<sha>` stamp, no changelog/signing gate, version.ts restored in finally), bun-vs-vitest wrong-harness guard (instant clear error), rig image-hash cache moved to /tmp (regress no longer dirties the checkout). `docs/papercuts.md` live and founder-mandated: append EVERY friction finding as it happens. Carry-overs: founder dev-binary validation pass (staged `~/rbox-dev` ×3 hosts, RBOX_API=dev one-liner), CLI release after it, Stripe "90-day history" copy (#3), 155 fold + 158 e2e-loop still parked._

 — **ALL 24 VALIDATION-AUDIT ITEMS RESOLVED OR FOUNDER-PARKED + PROD PROMOTED (1d68d35).** The founder's from-scratch validation list (`docs/validation-2026-07-18-new-user-flow.md`) is fully drained: PRs #326–#333 merged same-day — #326 gc-phase1 cursor-flake fix (batched seeding), #327 Stripe checkout prefills the sign-in email (reuses notify.ts ownerEmail, soft-fail), #328 seven CLI polish items (authorize menu browser-first + "Approve a code" REMOVED (duplicate of the browser device-code path), c-copies-auth-URL, workspace definition in setup, 10s slow-notes, calm git-history line, no-reboot start-sync copy, workspace-name+hostname final screen), #329 byte-based progress (scan shows bytes, upload gets 5s-window MB/s + stability-gated ETA via pure sample-fed estimator `transfer-rate.ts`, ALL transfer percents byte-derived, decimal units), #330+#331 flake hardening (watcher-retrust ±1ms clock race + codex sweep of 10 more test files: sleeps→handshakes, wall-clock→logical clocks; 6 deliberate note-onlys where timing IS the contract), #332 post-setup "Set up another machine" one-shot (reuses pairCreate; note: "run \`rbox pair\` on an already-paired machine"), #333 dev telemetry (phase-report summary + multipart instrumentation) gated behind existing RBOX_DEBUG at the print boundary. Also: CSP `font-src 'self' data:` (#24) on main; billing_interval backfilled for the founder's prod row ($200/year renders); **prod promoted with founder pre-authorization** (deploy-api + Pages green); **dev binaries staged on all 3 fleet hosts as `~/rbox-dev`** (built from main, version-string says 1.7.3 due to the changelog gate — content is main-tip) for the founder's `RBOX_API=https://rbox-dev-api.brian-via.workers.dev ~/rbox-dev setup` validation pass. **Design 158 (e2e validation loop) committed + PARKED**: U1 disposable dev-Clerk account mint/burn script, U2 dev-backed rig scenario (mint→setup A→pair B→sync→burn), U3 fleet dev-build staging helper — founder: "soon but not atm". REMAINING from the audit: #8 typeahead dir picker + #9 gitignore preview + #22 renewal emails (founder-excluded; #22 until real users), #3 Stripe dashboard "90-day history" copy (founder's edit + retention decision). New standing rules (in agent memory): flaky shard → parallel codex fix + rerun-watcher (check startedAt vs completedAt — 40min "in_progress" was runner-queue starvation, executed in 61s); review effort proportional to task complexity. Ops: session background tasks kept getting externally killed — `setsid` detach + sentinel files (CODEX-DONE) + persistent Monitors is the resilient dispatch pattern; codex sandbox can't run the Docker regress gate (rerun locally via `sg docker` every time). CLI release for #328/#329/#332/#333 PENDING founder validation via the staged dev binaries._

 — **DESIGN 155 SHIPPED to branch `claude/affected-only-test-loop-a7ssby` (PR pending): `bun run test:affected`** — reverse import-graph selection (src/+scripts/+apps/api incl. `?raw` assets and repo-path string literals) from the merge-base(origin/main)→working-tree diff; runs only affected bun test files + affected api vitest files with provenance per selection ("← changed file"); conservative fallbacks (toolchain/config → full bun suite; anything reaching apps/api/src, wrangler.jsonc, migrations, or vitest.config → full `vitest run` since api tests exercise the composed Worker over SELF in one workerd); changed-but-untested files reported, never dropped; ~150ms selector overhead; measured: leaf CLI edit 190s→~1s, single api test 60s→1.5s. Local accelerator ONLY — CI shards stay the merge gate. **Metadata-heal flake QUARANTINED locally** (`test.skipIf(!CI && !RBOX_RUN_QUARANTINED)`): root cause NOT established — passes isolated AND full-suite on Linux under bun 1.3.11/1.3.14 (15+ attempts in the remote sandbox); every known failure is a macOS dev machine (nightly runs + codex sandboxes). CI keeps running it; assertion restructured to a combined {committed, deferred, encryptCalls} tuple so the NEXT opted-in failure self-attributes (scan/churn defer vs re-encrypt vs conflict) — capture that output on the Mac (`RBOX_RUN_QUARANTINED=1 bun test src/cli/sync/sync.test.ts` won't do it alone if the trigger is full-suite context; use `RBOX_RUN_QUARANTINED=1 bun test src/cli`), then root-cause and delete the skip. Registry note: "green means green" restored for `bun test src/cli` on dev machines._

_Last updated: 2026-07-17 (day session — "quota fixes/git improvements") — **DESIGN 138 MERGED (#306) + 142 PHASE-0 MERGED (#305, +143/144 fixes #307) + v1.6.9 FLEET-LIVE + STORAGE INCIDENT ARC CLOSED.** **138 reset-path hardening MERGED**: 9 adversarial rounds (convergence 10→9→8→5→4→2→1), NORMATIVE crash-window row table (codex-derived, ratified), unforgeable consent witness threading 137's wizard seam, repository-order lock fence, daemon halt/heal, crash-resumable quarantine + `rbox doctor reset-journal`; scrutiny's 4 safety hunts CLEAN, 2 composition MAJORs found+fixed (quarantine→rebind dead-end; observation-error poisoning); the derivation also found 2 power-loss fsync bugs. UNRELEASED — rides the next CLI release (v1.7.0 candidate; Max-window rule applies). **STORAGE ARC**: founder acct hit 250/250GiB ⛔ → +100GiB bump (350 cap), fleet-wide respect-gitignore flip, 95,324 legacy paths purged (desktop) + 12 (Mac second pass) — the scary 32k "resurrection" was the Mac's design-44 changed-file guard correctly deferring deletions mid-build, self-drained; usage ~253GiB is now RETAINED HISTORY (365d) + unknown leak share — **142 Phase-0 storage-truth runner MERGED** (read-only decomposition: partition + Phase-1 health probe + R2 reconciliation; scrutiny 8 findings → SHIP; wrangler remote-bindings hang → REST adapter #307; timestamp-gaps degradation for the best-effort commits mirror) — **live founder measurement IN FLIGHT** (route promoted to prod ×2 today). Path down: measure → reclaim stranded/drift via existing GC (or cap fix if probe says fail-closed) → 142 Phase 2 active-state quota (founder-ruled: quota = active files, history tiered/fair-use 5×, pricing unchanged, accelerated pruning TABLED, site copy after ship). **141 git-shapes**: ALIGNED v3 (13→6→annex; 637-line code-derived outcomes annex normative), implemented, FOUR live rig runs (fails 29→5): confirmed engine gap `bisect-invisible` (sidecar-recorded, follow-up design owed), partial-clone "hydration" was an observation artifact (retracted); final 5-fail fix round in flight (s5-rebase convergence may be a 2nd genuine gap). **Also**: RboxBar Raycast bug fixed (candidate list omitted ~/.rbox/bin — the installer's own path; uncommitted, PR pending), hourly founder-update cron live, stale cross-session shells audited/killed. Queue: 141 finish → PR; bar-fix PR; STATUS/artifact refresh; structural cycle (apply.ts split + 15 unproven invariants) next after 141; git-shapes Tier-2 + native-mac backend + bisect-gap + s4-hydration follow-ups named; 139 plain-words pass queued. Founder pendings: v1.7.0 timing; 253GiB decision after measurement (Phase-2 vs retention-trim)._

_Last updated: 2026-07-17 (overnight autonomous run) — **v1.6.8 FLEET-LIVE + DESIGNS 137/140 MERGED + AI-UX VALIDATION LOOP OPERATIONAL.** **v1.6.8 released + fleet×3** ("zombie branches rest in peace"): 130 branch hygiene + 134 second-device clarity (Ryan's feedback, same-day); production promoted (dashboard live); changelog pipeline FIXED end-to-end (RBOX_HOME_DEPLOY_HOOK minted via CF API → repo+release-env secrets; release run green attempt 3). **The new loop**: designs 135/136 built a containerized TUI-walkthrough harness (fresh-machine + tmux driver, ux=1 containers, dev-only) → 20 developer-persona flows found 3 P0s (tilde literal-dir; typo'd path mints a phantom workspace; wizard exits where engineers expect re-prompt) + 8-flow "stupidly simple" clarity audit (scorecard 12/21/36; copy backlog = future 139 plain-words pass) → **design 137 wizard resilience MERGED (#303)** (4 review rounds, v5; Rule 0: retry only local pre-network validation; mutex-before-mint; shared token parser by construction; scrutiny spec-neutering audit CLEAN) → **design 140 deterministic regression gate MERGED (#304)**: `bun scripts/ux/regress.ts` (now in the release checklist) — 11 flows, ALL PASS live incl. the six 137-detectors that PENDING-FAILed pre-merge and XPASSed post-merge. **INVARIANTS.md MERGED (#302)**: 138 engine promises in plain English, 15 with NO test proof (feeds the queued structural cycle: apply.ts split owed since 113 + >800-line hot files). Dev noise muted: new-account pings (#300) + fleet alerts (#301) silent on dev deployments (rig/UX traffic isn't customers). **INCIDENT (resolved, productive)**: harness smoke with HOME-isolation-but-not-cwd let a dev-pointed rbox plant a foreign reset journal in the desktop's PROD workspace (daemon pump errored until quarantined) → exposed 2 engine bugs: stream-mismatch auto-reset without consent + the 64MB reset-read cap that ALL THREE fleet state.json files (~77MB) exceed — recovery is currently impossible fleet-wide → **design 138 reset-path hardening IN REVIEW** (worktree reset-hardening; round 3 done, 8 findings; v4 fold = next task; convergence 10→9→8; this is 130-grade machinery — consent capability on the destructive primitive, read-only crash-state classifier, sync-halt on journal uncertainty, crash-resumable quarantine). **QUEUED (founder-sequenced)**: 138 v4→ALIGNED→implement; git-shapes burn-in design (Tier 1 greenlit: submodules, LFS, NFD/case-insensitivity, shallow/partial clones, in-progress-op matrix — ONE design, parallel fixtures, starts when CLI rework settles); structural cycle; 139 plain-words. **FOUNDER DECISION PENDING: tag v1.6.9 (137's onboarding fixes) before Max's window or hold.** Release gate for it: regress.ts green (it is). Reports for Brian: scratchpad UX-REPORT.md + CLARITY-REPORT.md (sent). Standing overnight authority honored: merge-on-green+scrutiny yes, tags no, prod promotion his._

_Last updated: 2026-07-16 (night) — **v1.6.7 FLEET-LIVE + DESIGN 130 MERGED (soaking, unreleased) + PRODUCTION-BRANCH PIPELINE VALIDATED + MAX-ONBOARDING PREP.** **130 follower branch hygiene MERGED (#297)** after the deepest cycle ever: 11 design rounds (v6 single-invariant rebuild: BASE-absent only-by-CAS + A(R) artifact; v9 clean-room consolidation), high-reasoning implementation, a safety scrutiny that caught a FEATURE-NEUTERING provenance bug (origins stripped on every uneventful pull — green design rounds + green suites would have shipped a silent no-op; the missing follower e2e was the vector) + a dropped crash gate, retrofit-surface regression triage, live Docker-rig validation (failure set == pre-130 known-races EXACTLY after 2 scenario assertions learned designed behaviors), and a 3×-CI-red mystery that was an absolute-path import in a copied repro test. **RELEASE-GATED: soaks on the fleet via dev builds; ships in v1.6.8 after rebase-churn evidence.** **v1.6.7 RELEASED + fleet-live** ("a first sync you can predict"): design 133 onboarding polish — founder flipped the wizard default to RESPECT .gitignore (sync-everything stays as the honestly-worded E2EE opt-in, !re-include + mode-toggle escape hatches taught in-flow), honest ignore --list, truthful README/docs, browser-first signup; from a fresh-eyes onboarding audit (remaining: macOS notarization candidate, bare-rbox docs). **PIPELINE REBUILT + VALIDATED**: `production` branch is the only deploy source — resurrected test-gated deploy-api.yml (tests → prod D1 migrations → deploy → versions; founder disconnected prod Workers Builds; DEV Workers Builds on main kept — every main merge auto-validates on dev); first promotion (04c2aff) green end-to-end. Publish's changelog step needs repo secret RBOX_HOME_DEPLOY_HOOK (founder; binaries published fine — not a tag-move case). **MAX HOWELL (Homebrew) MAY ONBOARD ≤24H**: no releases in his window unless fixing something HE hits; he gets v1.6.7; .rboxignore field-validated end-to-end (ignored path never left the machine; control synced ~30s round-trip). **RYAN FEEDBACK (second-device flow) IN PROGRESS**: pairing-token provenance unexplained, post-link dead-end (no attach-existing-workspace guidance), "code" vs "pairing token" are TWO credentials reading as synonyms, dashboard→docs link missing — recon done→fix bundle next (Max hits this seam day 2). Parallel-session collision: #296 claimed design №132 mid-flight (mine → 133); rig test-device alerts (6×, orphaned dev accounts) → #293 rider. Flake registry+: §11 concurrent-saves E2E re-confirmed (docs-only branch + green rerun; 07-13 determinism fix still owed). Backlog+: orphaned device_sync_state rows invisible to admin purge; `rbox ignore --review` picker (founder idea); notarization; ~190 stale merged branches enumerated for deletion. Prior header below._

_Prior header (2026-07-16 evening): 2026-07-16 (evening) — **DEPLOY PIPELINE SPLIT: `main` is integration-only; verified green candidates are explicitly promoted to deployed `production`, where web deploys and prod D1 migrations run**. **v1.6.6 FLEET-LIVE + FLEET FULLY CONVERGED — "do 2 then 1 then 3" arc complete (designs 127/128/126/129, PRs #288/#289/#290/#291, all merged same-day) + two designs in review-flight (130/131)**. **127 fleet push alerts LIVE ON PROD**: hourly cron evaluates D1-only conditions (drift >24h per binding with positive-evidence-only resolution; reporting_stopped per device, latched, 2.5h onset) → #rbox-alerts via a new fleet_alert SlackPipes event; claim-fenced sends (conditional state write whose WHERE re-asserts the source condition — concurrent crons can't dupe, stale snapshots can't claim; NO failure reversion, at-most-once per window), incident model (2h continuation debounce, one ⚠️/✅ pair per incident via resolve_notified_at, "still:" dailies, 7d silence, 30d prune), migration 0028 alert_state, lifecycle deletes + evaluator deletes zero-row stopped incidents outright; 5-round design review. **128 show-me batched proofs**: thousands of serial subprocesses → ≤5 (batch-check with ^{commit} peel + positional parse, fail-closed rev-list --quiet integrity walk — review's reproduced CRITICAL: batch-check alone misclassifies missing-parent commits as owned — streamed roots-closure ownership O(candidates) memory, batched subjects), presentation-only 50-cap (protectedOids/JSON exhaustive), show-me-only stderr progress; **field-proven: 2.5s on the repo class that ran 30 minutes** (542 candidates ~25s on Mac rbox-core). **126 ORIG_HEAD breadcrumb waiver (7-round review at high reasoning)**: exhaustive OP_STATE_CLASSIFICATION (ORIG_HEAD sole breadcrumb), presence-gated sole-blocker waiver finalized only after the journal published flip, preservation-before-adoption (refs/rbox-recovery capped 8/worktree + capture --exclude=refs/rbox-* closing an internal-ref bundle-leak class + quarantine arm), journal-owned ORIG_HEAD.lock (journal.id sidecar ownership); **scrutiny pass caught 3 implementation safety regressions post-design-alignment** (2 new journal crash-window strands, 1 boundary preservation bypass) — the layered process worked. **129 org tidy** (founder ask): CODEMAP apps/api section + sanctioned protocol-module policy + telemetry/ mapped; watcher/ambient-status/drift-audit → cli/daemon/, git-deferral-json → sync-git/, release-verify helpers homed, readBodyCapped/packKey → api util, 88 dead engine barrel exports pruned; watcher SCALE test RSS gate → delta-based (order-fragile absolute). Audit verdicts: apply.ts +112% over its 113 plan (NEEDS ITS OWN SPLIT CYCLE — recommend next), daemon.ts +30% over exception budget; apps/api featurization deferred (~fine at 41 files). **FIELD ARC — the day validated its own designs**: today's release churn reproduced the ORIG_HEAD strand on Mac (BOTH repos) exactly as predicted; investigation revealed the waiver was correctly VETOED by heldRefs — root cause: **squash-merge workflow strands every merged-deleted branch as a permanent per-ref hold on followers** (Mac rbox-core: 83 local-only commits across dozens of dead branches; rbox-admin: an amended local-dev-prod). Remediated fleet-wide with take-theirs (Mac+FM, both repos, quarantine bundles preserved) — **fleet fully converged on v1.6.6**. Diagnostic gap noted: waiver veto logs nothing (rider in 130). **DESIGN 130 (follower branch hygiene, ref-deletion tombstones) v5 — 4 review rounds done (16→8→5→2 findings), ROUND 5 PENDING — worktree feat/branch-hygiene pushed; NEXT SESSION: run round 5 → ALIGNED → implement (advertised-value tombstone chains, LIVE+BASE+consumed-marker provenance, expected-absent-CAS retirement with generation fencing, keep-pin preservation with aging tombstone origin, single outbound normalization boundary with pending exemption, §126 veto-logging rider)**. **DESIGN 131 (rig runtime backends: Apple container + Docker/Linux — shortens Claude's validation loop to localhost) v2 — round 2 in flight, worktree feat/rig-portability; RunnerBackend seam in lib/container.ts (single choke point, verified), canonical StatsSample contract, container-label recreation enforcement, daemon-info doctor + transient probe, acceptance = full Docker FAST_SUITE on via-desktop vs rbox-dev-api**. Ops: wrangler token at ~/.secret_env_vars (memory updated; dev-first unblocked), fleet-SSH permission rules added by founder (autonomous rollouts now), PREMATURE-MERGE lesson recorded (#290: gh pr checks --watch exited 0 with pending checks; gate on run conclusion — the failure was a proven fixture flake, rerun green). Backlog+: apply.ts split cycle; chaos-restart on Docker (Apple-wedge exclusion may not apply); alert_state veto-gate observability rider (in 130); squash-merge residue on any NEW follower joining before 130 ships (take-theirs playbook applies). Prior arcs below._

_Prior header: 2026-07-16 — **v1.6.5 SHIPPED — the fleet phones home (design 120 telemetry ingest + cockpit, PR #287 + rbox-admin panels, same session unpark→prod)**. Design 120 (drafted by the cockpit session, parked) was unparked on founder go-ahead: 4 open decisions resolved (D1 was ALREADY SHIPPED as `devices.last_seen_version`/0026 — recon caught the doc stale; D2 single route + declarative hard validator; D3 per-family client retention + `RL_TELEMETRY` namespace **2006** per-device limiter, no stateful server state; D4 separate `POST /v1/fleet/sync-state` **aggregated per device×workspace×project×binding_id** — server has NO repo concept, per-repo would be a path-id leak; drill-down stays on-device via 124) through a **5-round codex adversarial review to ALIGNED** (27 findings; keepers: random per-root `binding_id` kills the multi-root alert-flap, **ages-not-timestamps on the wire** (unsynced clocks), server derives corpusBucket/mbps (client-derivable = contradiction surface), dispatchReason UNREPRESENTABLE per-push → family is per-push×transport, revocation cleanup guard must live IN the DELETE statement for retry-safety). Server: `POST /v1/telemetry` (schema-table validator via `satisfies`, normalized-positional-only AE writer, canonical-value blob reconstruction, hostile-mbps guards, per-reason drop counters incl. bad_state/unauthorized), migration **0027 `device_sync_state`**, lifecycle deletes (ws-purge inventory + account-delete device-id prefetch BEFORE directory delete + plane-clean revocation), rider fix: invalid `x-rbox-version` can no longer NULL a stored version. Client: `TelemetryQueue` (safety events coalesced/never-evicted, capability latest-slot, per-family rings, 120s unref'd flush, 429 backoff, permanent-4xx discard, `RBOX_TELEMETRY=0` kill switch, post-drain 1.5s shutdown flush), push-scoped ALS lane accumulator (settled-HTTP-requests only, batch/pack/single), `SyncStateReporter` reusing 124's `projectGitDeferralRepos` (cockpit and device can NEVER disagree) + fingerprint gating + hourly heartbeat. Process: /simplify 4-angle (9 applied — incl. telemetry rides RboxApi's ONE RemoteContext) + /antislop scrutiny (8 applied — **FIX-NOW caught: `ensureTelemetryBindingId` could clobber a legacy/mismatched sync baseline; now throws instead of manufacturing state**). PR #287 CI green → founder "merge it" (dev-first verification WAIVED this once: wrangler auth unavailable on desktop — routes have zero existing callers, migration additive-only). Prod verified live (both routes 401 at auth gate), **v1.6.5 released**, desktop upgraded + **positive end-to-end proof: bindingId `61259a7bdf468076` persisted + zero failure lines = prod D1 row exists**. **rbox-admin cockpit: 7 panels shipped to main (`8b34e8d`)** — propagation p50/p95 (labeled delivery→apply, honestly), first-publish funnel by corpus bucket, fleet version+capability (the #270 pool-silently-dead alarm), upload-lane Mbps by transport, **fleet drift table (24h alert = `oldest_deferral_age_ms + (now−reported_at)`, 2.5h staleness dimming)** — the panel that would have caught the Mac's 4-day ORIG_HEAD strand from a dashboard — client safety ticker, ingest-drops health. AE queries `_sample_interval`-weighted. **PENDING: Mac + FM upgrades to 1.6.5** (SSH fleet writes need founder approval outside auto mode — two commands: `ssh dfinitiv-macbook-pro 'cd ~/Development && ~/.rbox/bin/rbox upgrade'`, same for flat-meadow-prod-main-01; until then those daemons emit nothing). Wrangler auth on desktop still absent (dev deploys blocked; `npx wrangler login`). Watch items carry: ORIG_HEAD/126, git-entanglement scenario hardening, resolve show-me perf, upgrade stale-runtime-dir UX, json-output DI._

_Prior header: 2026-07-16 (past midnight) — **v1.6.4 FLEET-LIVE — logs that rotate, deferrals you can see and fix (designs 124+125, PRs #285/#286, founder-ask → fleet same evening)**. Born from the founder's RboxBar screenshot ("2 repos deferred · 1h — what do we do here?"): **124** menu-bar deferral drilldown (≤5 repos, plain-language reason + both ages, provenance labels, +N more) + **Copy Git fix brief** (self-contained human/LLM-pasteable doc: per-repo diagnosis, transient-vs-decision honesty, POSIX-quoted cd-anchored commands, `-- end of brief · N repo(s)` terminator; unknown/forged reasons can NEVER render resolve commands — capability gate shares the resolver's own predicate) + `rbox git deferrals [--brief|--json]`; ambient status carries a bounded sanitized deferral array (schema v1 additive, per-item drop, version-skew safe both directions); RboxBar gained a capture-with-timeout subprocess API (deadline-bounded post-kill drains — descendant-held pipes can't hang the bar) + generation-tokened clipboard state machine; 62/62 swift on the Mac; **field-proven within the hour on REAL deferrals** (brief output verbatim-correct). **125** daemon log rotation: daily `daemon-YYYY-MM-DD.log` (sync O_APPEND, one-Date records, multi-process-safe protocol), 14-day filename-date retention (`RBOX_LOG_RETENTION_DAYS`), `daemon.log` demoted to guarded crash sink (5MB boot guard + pointer records), `rbox logs` merges streams chronologically + follow survives rollover/restarts, ALL direct readers migrated (starvation probe, doctor, rig, swiftbar — helper renamed `daemonCrashLogPath`), operational console bypasses routed through the injected sink, `repoMs=` capped at 8 exemplars + queue/wall/chain p50/p95/max (designs 74/83/100 signals preserved; full line under RBOX_DEBUG) — context: Mac daemon.log was 44MB/8 days, 75% of it ONE v1.6.2-era line already killed by 118's backoff. Fleet upgraded via managed `rbox upgrade` (dogfooded; works — but lists stale benchmark runtime dirs as scary ✗ failures: UX finding below), dated files live on all hosts, RboxBar rebuilt+reinstalled. **TEST RIG REPAIRED + field-validating again** (was fully rotted): login lost `--no-interactive` in v1.6.1; image git 2.43 < the 2.46 symref floor (git-core PPA → 2.54); **PID-1 `sleep infinity` never reaps → dead daemons persist as ZOMBIES that still pass pid-liveness lock probes and wedge every later sync** (image + create calls now run tini; Apple `container` IGNORES Dockerfile ENTRYPOINT — pass init in create args; `rig down` before `up` when image/create-args change). two-device-live green on 125 code; git-entanglement has its own pre-existing scaffolding races (update-ref 128 on fresh containers, edit-lane follow timing) — needs a scenario-hardening pass. **MORNING REMEDIATION (same session): Mac "Degraded" panel root-caused** — (a) FSEvents drops from desktop-churn applies → periodic-scan fallback working as designed, cleared by restart; (b) **ORIG_HEAD op-state three-way mismatch NEVER self-clears** (follow.ts:368 defers unless live matches base OR incoming; a follower that misses the window while the publisher rebases is stranded forever) — Mac's rbox-core sat on a 4-DAY-old HEAD; fixed by writing the publisher's `.git/ORIG_HEAD` value on the follower → git-sync followed clean in one cycle; **REPRODUCED AGAIN same evening** by the 124/125 rebases (Mac+FM re-aligned). WATCH ITEM (founder call: monitor, don't build yet) = **design 126 sketch: classify op-state files — in-progress markers (MERGE_HEAD, rebase dirs) keep deferring; breadcrumbs (ORIG_HEAD) get waived+adopted when every real-work guard passes**. Also found: `rbox git resolve` show-me ran 30 MINUTES with zero output on the 150k-file repo (serial git subprocess walk — needs progress + perf); `rbox-admin` "local commits" deferral was manifest-lag misclassification (Mac was a pure follower all along). Backlog+: rig portability (Apple container + Docker/Linux — founder ask); `rbox upgrade` stale-runtime-dir UX; json-output.test reads the real signed-in account cache (fails on dev machines, passes CI — needs DI); worktree deletions leave rboxignored husks fleet-wide; Bun quirk recorded: `process.exitCode = undefined` cannot clear a set code. Prior parked/backlog items carry (identity-cache self-heal unpark candidate, RboxBar 100%-label, build.log churn, open-source pre-flight)._

_Prior header: 2026-07-15 (evening) — **v1.6.3 FLEET-LIVE — the lock-hardening release (designs 118/119/121/122/123, PRs #279-#284, all merged same-day)**. Born from one founder question ("any problems in the logs?") → fleet sweep found: Mac starved 26h (macOS kern.uuid is PER-BOOT → own stale lock read as foreign → 341,824 spin lines), `rbox git resolve` field-broken (marker leak + swallowed errors), FM's git 2.43 lacking symref-update, and a case-colliding branch wedging savvy-core on APFS. All remediated live (fleet deferral-free) AND productized: **118** stable darwin identity + boot-alias ledger + locality-gated probe (unknown-hostId markers on a proven-local fs = identity drift → normal dead-probe reaping; fail-closed via the kernel's own MNT_LOCAL flag after field validation caught `stat -f %T` returning file-type — locality was inert on macOS until the real-adapter test pinned it), break-path exact-ownership cleanup incl .reap fence, >15min starvation surfaced in status/doctor + counts-only lockStarved metric, abortable 250ms→30s pump backoff, typed resolve errors (sync-busy), doctor git-capability probe, `rbox upgrade` stop-and-WAITS + restarts all daemons + status version-skew line (field-verified verbatim). **119** per-device last-seen CLI version (x-rbox-version header; 60s change-floor vs mixed-version ping-pong). **121** RboxBar once-per-version update notification + one-click managed upgrade (39/39 swift on the Mac; app rebuilt+reinstalled). **122** slackpipes via waitUntil + 5s/retry + #rbox-alerts self-report with URL derivation — root cause of the missed customer-signup pings was the 700ms inline timeout (prod-log receipts), NOT missing config; both channels field-verified 202. **123** the 'shellStateOf host flake' WAS NEVER A FLAKE — a stale hardcoded cliVersion literal in a full-DTO fixture; blocked the first v1.6.3 build twice; registry corrected: same-SHA metadata heal is the ONLY tolerated flake. **BUSINESS: rbox has a real paying customer** (coworker, pro, since 07-11, engineer) — standing rule recorded: deploy main freely, mind breaking changes (client-skew story per protocol change; see memory prod-customer-compat). PARKED→UNPARK CANDIDATE: identity-cache self-heal (customer machines show acct-id fallback). Backlog+: RboxBar progress label sits at '100%/syncing' during apply phase (cosmetic); home-dashboard build.log syncs every 10min (rboxignore candidate)._

_Prior header: 2026-07-14 (evening) — **v1.6.2 FLEET-LIVE (identity banners, design 117)**: untracked-dir menu / setup skip-notice / `rbox account status` / status ACCOUNT section show "Signed in as email (method)" from a new non-secret local cache (`~/.rbox/account-profile.json`, 0600, terminal-injection-sanitized, accountId-keyed, logout-cleared; fills on any successful account fetch, banners stay network-free; acct-id fallback for cold cache / CLI-only accounts). Server: `/v1/account/status` returns the design-16 cached email + REAL GAP FIXED — provisioning now seeds the email cache at FIRST login (was NULL until 2nd web login; also helps new-device alert recipients); `email_updated_at` stays NULL at seed so the returning-login refresh throttle is untouched (contract documented at clerk.ts write + notify.ts read). PR #278; dev-first deploy verified; prod field-proven (endpoint returns founder's email; banner renders it end-to-end; signInMethod null until next web login — renders without parens). NOTE for founder: your `signin_method` fills on your next app.rbox.to login. PARKED (founder call, single-user): identity-cache self-heal on cold banner render — fresh machines show the acct-id fallback until the first `rbox status`-class command fills the cache; revisit at onboarding polish / first external users (spec was drafted, cycle stopped, worktree removed)._

_Prior header: 2026-07-14 (afternoon) — **v1.6.1 FLEET-LIVE (bare-rbox front door)**: enrolled bare `rbox` in an untracked dir now shows a menu (Track this directory / Sync existing / Nothing) instead of jumping mid-wizard to "Step 2 of 3"; setup step numbers count only steps that run; daemon-aware Pause/Start in the front door; 4 audit-backlog copy fixes rode along (pair finish path, bootstrap-secret prompt, first-run error → setup). PR #277 (opus UX design pass → codex impl → /simplify 7 refactors → /antislop), all 3 hosts verified 1.6.1 + menu live-rendered. **SITE DRIFT AUDIT**: 13 verified findings vs v1.6.0 CLI in `../rbox-home-page/docs/cli-drift-2026-07-14.md` (highs: `rbox recover` documented as phrase re-enrollment — wrong since 0.9.14; extra-storage $3/100GB advertised but unpurchasable — checkout/webhook single line-item only); founder had codex apply. **OPEN-SOURCE READINESS (CLI + API)**: full-history scan (1,191 commits, all refs) found ZERO credential-grade secrets and no obscurity-dependent server code (auth fail-closed, ctEqual, 404-on-cross-account, no bypasses) — E2EE architecture is open-source-safe by design. Pre-flight before any public flip: (1) hash the hardcoded admin-allowlist email in `apps/api/src/admin.ts:28` (keep the not-env-weakenable property), (2) exclude/redact STATUS.md + design/93 + perf-improvements.md (fleet topology, device/workspace ids, personal emails), (3) publish as FRESH-HISTORY mirror (b6e3550b sweep + Stripe Projects ids + personal data are permanent in history; filter-repo across ~260 branches not worth it). License decision pending: FSL/BSL (no competing hosted service) vs AGPL server + MIT CLI; marketing verdict: net-positive for an E2EE dev tool (trust, curl|sh credibility, solo-founder continuity answer), self-host cannibalization low (CF-native stack = real friction), self-hosting to be declared unsupported._

_Prior header: 2026-07-14 — **DESIGN 116 SHIPPED + FIELD-PROVEN: v1.6.0 fleet-live; live round-trip test PASSED — desktop branch switch at 02:37:07, Mac FOLLOWED at 02:38:18 (71s) with uncommitted work intact, and followed back. PR #276 (67 files, 2 review rounds: 8 BLOCKERs fixed, 48-case matrix); CI identity-less env caught a real fresh-machine fatal (fixed: synthetic ident fallback). Per-ref holds + OID-equality live (Mac freeze class dead). rbox git resolve: show-me + take-theirs (keep-mine next cycle). THE ENGINE PROGRAM IS COMPLETE — remaining: one hygiene cycle (§11 flake, grant-overlap un-skip, sweep grep, rollback-floor id), evidence-gated parks (packing cold-join, 115 crypto, 110, 98), then product surface (admin cockpit, landing page — codex briefs synced to other machines)._

_Last updated: 2026-07-13 (evening) — **FLEET v1.5.3. 114 PACKING: built+merged (#271, 8 commits, fence suite 32 tests), server accept+GC shadow ON (#272), field validation VERDICT: DO NOT PROMOTE (mechanics perfect — 20,408→45 R2 PUTs, zero errors — but ~16%% slower: premise expired post-pool/fill-v2/admission wins + pack receipts redeem at 2x; writer stays RBOX_BLOB_PACK opt-in; 91 packs soaking shadow GC). NEW TOP LEVER: redeem/commit tail (14-40s both arms) + 111 DRAIN FIELD GAP (redeemOverlap=0 despite default-on — RC cycle running). 116 CHECKOUT-FOLLOWS-SYNC: designed (765 ln), reviewed ALIGNED 8 rounds/34 findings (#273), Phase-0 CONFIRMED+REPRODUCED root cause (#274): design-68 §3.2 worktreeCollision defers WHOLE git section on ANY linked-worktree branch match, no OID compare — Mac frozen since 07-10 by stale d93 worktree at IDENTICAL OID; swept 3 stale Mac worktrees → git plane self-healed to near-tip in <1min. Amendments enumerated (per-ref holds, OID-equality rule, worktree-shaped tests). RECOMMEND: .rboxignore .claude/worktrees (delete-first-then-ignore) — founder to call. Releases v1.5.0-1.5.3 (1.5.0/1/2 gates failed: grant-suite teardown hang + a cwd-slip tag; §11 flake now 3 CI strikes — determinism fix queued with grant-overlap un-skip). Junk ws pending purge: ws_332ae0cca4534c07a239eb524f9da484, ws_50e1b93a0e3e4a4a8a3ca6ce80b20b59, ws_b24e5046b4bf4db0957d6000c4475395, ws_d632dd086dbd4aa5af4337aac6ea63d1.** **v1.4.2 FLEET-LIVE (Bun compile bug #270): crypto pool RESTORED in release binaries — every prior release silently ran inline crypto (Bun 1.3.5 ignored text import attributes under --compile; 0-byte worker extract + the ref'd handle behind the init exit-hang). Fleet smoke: 16/10/14 workers active (desktop/Mac/FM), workerExecutions>0 first time ever; Bun pinned 1.3.14 + engines caret; compiled-exit regression test guards the class. Re-baseline encrypt walls next bench. Designs: 114 packing ALIGNED+merged (impl cycle running), 109 grants LIVE (#269, bearer-always), 115 crypto shelf (+bandwidth-knee addendum). Junk ws purge pending (~9 ids in ledger).** **GOAL COMPLETE: fleet on v1.4.1 (all defaults live: files-first, fill-v2/32, upload-time draining, enforce admission). FINAL BENCHMARK (FM, shipped defaults, no env): greenfield 9.7G/118k files → files usable at 226.7s / full publish 336s (Mac sprint-start baseline 578s); redeem tail 37.4→22.3s; admission 6,653→281ms (n=716/169); propagation publish→apply 17s (manual baseline 41.5s). Sweep verdicts applied in v1.4.1 (fill-v2 kept −14.1%, 64-records rejected −7%). NEW: 109 grants IMPLEMENTING (hygiene reframe, bearer-always constraint), 114 blob packing DRAFTED+IN REVIEW (the 200Mbps small-file lever — R2 object-ops bound, ~733ms/req settle). FOLLOW-UPS: post-setup exit lag >60s on 1.4.1 init (possible #246 partial regression, benchmark unaffected); junk ws to purge: ws_aede5f5f775c4a1ea89a22a8c67a2d1c, ws_6d4da814e4bf43bcaf99d204348d4883 + older short-ids; 110 Phase-0: commit p=23.9s at genesis (real, not no-op — revisit after 114).** **IMPLEMENTATION PHASE COMPLETE: 112 merged (#264 fill-v2+telemetry+latch, #265 server cap 64 dark, #266 sweep axes w/ prod-refusal + effective-remote assertion), 111 merged (#267 upload-time draining + bounded redeem cap + Phase-0 receipt/server instrumentation, defaults off). ZERO open PRs. IN FLIGHT: FM 112 evaluation sweep (6 matched cells / 2 repeats, ~2h; its v1/32 baseline cells double as 110 Phase-0 attribution — 110 expected to close as measured no-op). NEXT: sweep gates → 110 verdict → v1.4.0 + fleet → FINAL BENCHMARK presentation.** **DESIGN 113 MODULARIZATION COMPLETE: all 8 PRs merged (#253 plan, #256-#263 waves 1a-5). Six giants (sync, sync-git, daemon, crypto-pool, e2ee-remote, blob-batch; 8,700 lines) → ~24 owner-responsibility modules + docs/CODEMAP.md (115 module lines, cited by AGENTS.md); behavior-identical proven per wave (rename/content-equivalence, single-instance state, 3-cycle baseline, compiled crypto smoke, token-stream-identical comment sweep) + cumulative codex final pass ALIGNED zero findings. Review archaeology moved to ledgers (90 clusters), constraints kept. NEXT: implementation phase per binding order — 112 batch-fill cycle (fill-v1 instrumentation → fill-v2 → coordinated wire-cap raise w/ skew latch), then 111, then 110 conditional; v1.4.0 + fleet + final benchmark after.** **INSTRUMENTATION MERGED (#255: 111 overlap repair + 110 finalDrainMs + arm-generation guard, flags-off, 1452 tests) → 113 MODULARIZATION WAVE 1 LAUNCHED (3 parallel move-only agents: blob-batch, crypto-pool w/ mandatory compiled smoke, e2ee contracts; plan + REVIEW-113 merged via #253 after a codex round fixed 4 HIGHs incl. the CI shard-registry money-gate). Designs 110/111/112 all reviewed-to-ALIGNED and merged (#252/#250/#254); seam ledger carries the binding order + 112 addendum.** **DESIGN PHASE 109-111 CLOSED: all three reviewed to ALIGNED and merged (#251, #252, #250), joint seam round ALIGNED (REVIEW-109-111-seam.md carries the BINDING implementation order). 109 GATE 0 EVALUATED and PARKED: pre-handler auth is only ~89ms/request (~9s of the storm); the real lever is BATCH FILL — avg 17.3/32 records and 148KB of the 8MiB body cap per batch (~733ms server settle paid 2,360 times). Option D (batch fill / coordinated wire-cap raise) is the successor — design 112 draft dispatched. Binding-order next steps: flags-off instrumentation for 110+111, then the shared fixed-corpus baseline.** **102 ENFORCE LIVE ON PROD (#249): admitAccountMs 5,956ms avg → 213ms measured on first enforce commits (~5.7s off every push); 0 divergence/errors post-flip; kill switch = var back to shadow.** Design reviews: 109 ALIGNED (PR #251 — honest win re-sized to ~low tens of s, gate-0 AE decomposition before any impl; 2 BLOCKERs fixed: false quota claim, unobservable authn) and 111 ALIGNED (PR #250 — Phase-0 metrics repair first: redeemOverlap accounting unsound + uploadActive leak; upload-time draining survived all rounds). 110 loop still running; joint seam round after; neither design PR merges before it. **v1.3.0 RELEASED + fleet upgraded (all THREE hosts verified on 1.3.0, daemons healthy)** — files-first default-on, init fixes, purge route, knobs now fleet-live. Review cycles for designs 109/110/111 running (3 parallel agents, codex loops to ALIGNED; joint seam round after). Prior header below._

_Prior header: 2026-07-13 (late night) — **ALL FOUR PRs MERGED (#245 knobs+sweep rig, #246 init identity/exit fixes, #247 files-first, #248 workspace purge) and `RBOX_FILES_FIRST` now DEFAULTS ON (`f2403834` — founder call; genesis-only so inert for existing workspaces; `=0` kill switch; suite pins legacy via `scripts/test-preload.ts` + bunfig.toml, dedicated test asserts default-on).** **CI moved to GitHub-hosted ONLY** (founder: "not worth it") — self-hosted home box CPU-starved heavyweight tests into endless random timeouts (3 rerun rounds, 2 timeout bumps, 4×8-CPU reshape all failed to stabilize); both PRs greened FIRST TRY on GH-hosted; local runner containers torn down; Brian must remove his own crontab entry (`crontab -l | grep -v gh-runners | crontab -`) and repo secret RUNNER_ADMIN_PAT is now unused. **Workspace purge is LIVE on prod and field-proven**: dry-run → purge → verified-404 on the three sweep junk workspaces (blobs → GC). Older junk ws (short ids ws_79529b0d, ws_67eb29f6 + wired-bench) need full-id resolution via admin overview before purging. **FM files-first A/B RAN (stopped early per protocol, n=1/arm): mechanics ALL CORRECT** — two-phase publish (files seq 1 @ 225.5s → git attach seq 2 @ +104.4s), `fp filesSynced` KPI rendered, flag-off byte-identity clean in the field, **#246 field-verified (init self-exited + reused machine identity — both bugs gone)**. Gate 2 PASS (332.5s ON vs 342.4s OFF total). Gate 1 "FAIL" (225s vs ≤120s) is a WRONG-PREMISE fail: ~/code's file plane is **2.85GB wire (118,757 files / 49,382 blobs), not the assumed 0.4GiB** — ≥36s is line-rate-minimum; re-baseline the target before rerunning. **Real discovery: flag-independent critical-path levers — 2,426 auth calls (107.7s!), commit 46.1s (41.7s in `p`), redeem 37.4s; effective upload ~200Mbps.** Files-synced still beat full-publish wall by 107s on a file-heavy corpus; on the real 84%-git workspace shape the win is far larger. FM artifacts: logs /tmp/rbox-ff/logs, build /tmp/rbox-108-build. Junk ws to purge (with the older ones): ws_83dcdcf9d5b048269fbabcee188cc5e1, ws_4d87c0cf4abc4384bbe9608452cf4279. NEXT: v1.3.0 release (files-first-on + init fixes to fleet); designs 109 (auth storm) / 110 (commit tail) / 111 (redeem tail) DRAFTED by codex from FM evidence (839b776d, no review yet) — arbitrage review loops first; 102 enforce soak samples (accelerator stopped since incident #3); design 98 scheduling fix owed._

_Prior header: 2026-07-13 (night) — **four parallel dev cycles delivered: #246 MERGED (init device-identity clobber + never-exits — enrolled-identity precedence via `resolveWorkspaceDeviceId`, `shutdownCryptoPool()` on CLI exit, new doctor device check); #245 open (upload/download slot knobs + sweep rig); #247 open (design 108 files-first impl, `RBOX_FILES_FIRST` default-off, 2 codex MAJORs fixed: flag-off byte-identity + timing-singleton void-on-overlap; FM A/B validation next); #248 open (admin workspace purge — `DELETE /v1/admin/workspace/:id` + `scripts/ws-purge.ts` dry-run drain; NO workspace deletion existed server-side at all).** **SWEEP VERDICT (redirects the perf plan): the ~35Mbps uploader ceiling is NOT slot-bound — knee at 48 slots (+9%, noise), ≥64 slots COLLAPSES 3x via per-batch RTT inflation (0.9s→3s, zero retries/503s), server-side variance dominates (same config: 60 then 23Mbps plaintext), wire never past ~5% of FM's pipe. KEEP defaults 24/48; honest levers are server-side batch settle latency + the 32-record wire cap (coordinated change). The upload lane alone does ~60Mbps plaintext; the wall gap is encrypt+commit.** CI: shared-runner contention flaked 3 PR runs (pure timeouts in unrelated tests) → shard runner now passes `--timeout 15000` (700cb0ff); root fix owed = daily 5:15am container recreate cron (line written, crontab install permission-blocked — Brian pastes it; each ephemeral job leaks ~13GB/day/container, filled 760GB once). INCIDENT #4 (contained): init-bugs agent worked in the PRIMARY checkout (rbox-synced!) — WIP stashed/restored to its worktree, primary back on clean main, playbook rule recorded. Junk ws for #248 drain (after dev-trial + merge): ws_6c4621f6fa9e4f7cbf1c9019f016b1d1, ws_02e5d624636143568e5f8ad5ef739ca2, ws_f9b3ab9419194820a7fe4964ba68aea0 (~160k blobs) + the older 3 below. Stray branch `worktree-agent-ae0cca7dc6de5f88e` on origin needs manual delete._

_Prior header: 2026-07-13 (early) — **FM benchmark pair (gigabit host, clean corpus ~/code): serialized 315s; RBOX_PUBLISH_PIPELINE 540s (+71% — design 98 gate FAILED in the field**, suspect: multiparts serialized one-at-a-time on the pipeline's disk axis vs 4 giant git packs; flag stays off, result to REVIEW-98). **Bigger finding: the uploader caps ~35Mbps on EVERY host (30/37/35 on 155/­~40/630Mbps pipes) — a software slot×latency ceiling (~364 blobs/s ⇒ ~2s per 32-blob batch at 24 slots), i.e. a TUNABLE.** Next session first: slot/batch sweep on flat-meadow vs ~/code (telemetry = #230). Also filed tonight: init bugs (device-identity clobber + never-exits headlessly — blocks scripted onboarding); design 108 MERGED (#244, two-commit files-first; founder sign-off pending on publisher-loss git semantics); fleet = THREE hosts (flat-meadow was on v1.0.0 all week — now v1.2.0 + flags); ~/code testbeds cut on desktop + FM (founder rule: bench there, never live workspaces); 4-5 bench workspaces need server-side deletion._

_Prior header: 2026-07-12 (late night) — **fleet on `1.2.0-dev+868ed2c`**: scan fault isolation + mass-delete circuit breaker + dev-install hygiene MERGED (#243 — incident #2's full armor; unreadable-file faults DEFER, never delete; breaker trips at max(20%,1000) deletes, daemon can never self-override) + WS reliability (#242) live. **Wired greenfield control: 367s / 1.3GiB ≈ 30Mbps — same throughput ceiling as the Mac ⇒ the ISP uplink is the greenfield floor; design 108 (files-first, cycle running) is the lever.** Ubuntu device identity verified restored (dev_df5d3b6c — the old 'orphaned' STATUS note was stale; it's this host's live ID). Cleanup owed: 3 bench workspaces server-side (ws_79529b0d, ws_67eb29f6, + tonight's wired-bench ws)._

_Prior header: 2026-07-12 (night) — **v1.2.0 RELEASED + fleet upgraded** ("the Mac gets fast"): APFS bulk scans (−43%, stat=0 live), fold evidence fleet-wide (0.4–1.5s reads), 104 field-confirmed, 85 Layer A, GC Phase-1 fixed + 229k marks drained (35.3GB released), soak endpoint + propagation analyzer (p50 16.7s publish→apply, 0 staleness). Then: greenfield benchmark 578s (84% of bytes = git history) → design 108; WS reliability #242 live; init device-identity bug found+contained (INCIDENT #3 below)._

_Prior header: 2026-07-12 (late night) — **v1.0.1 RELEASED + fleet upgraded** (installer binaries, flags `RBOX_PREFLIGHT_DELTA=1 RBOX_CRYPTO_FUSE=1` on both daemons); wave-2/3 merges #221–#226 (102 shadow SOAKING on prod, 99 fused Phase 1, 98 Tier-1 pipeline dark, 100/98 instrumentation); GC drained 1,600/5,410 (~3.34GB) with the final sweep timer armed; telemetry sweep ALL CLEAR; **Mac watcher root-caused → design 104 placeholder** (FSEvents transient drops permanently un-trust the watcher ⇒ ~11% I/O duty cycle; fix = first dev-cycle item next session, pairs with v1.1.0 + design 84 which is still building)._

## 2026-07-12 night — greenfield 578s (84% git history) → design 108; WS reliability live; device-identity bug (INCIDENT #3)

- **Greenfield benchmark** (Mac APFS clone, new workspace, full stack):
  **578s**, 88k files / 114,787 blobs / **2.5 GiB up, 2.1 GiB of it git
  packs** (four 118–640MB packs; #230 multipart instrumentation decomposed
  them, zero retries). Encryption no longer the pole; uplink × git-pack
  volume is. Cross-workspace dedup impossible BY DESIGN (per-workspace keys).
  **Design 108 (files-first publish) cycle running**: files (~0.4 GiB ≈
  60–90s) commit first, history streams after; time-to-files-synced ≤120s =
  the greenfield KPI.
- **Design 105 reliability MERGED (#242) + fleet-live** (pong deadline 60s,
  5-min jittered backstop, session cap off until env set, notify_latency_ms
  token — first live sample 4726ms).
- **INCIDENT #3 (contained; product bug found):** bench `rbox init --new`
  **clobbered the Mac's machine-global device identity** — the main daemon
  pushed as the bench device (dev_932d7c02…) → ~200 probe conflicts, stale
  re-push of a deleted worktree, one git-sync conflict (local kept; bundle at
  .rbox/git-conflicts/remote-1783881771569.bundle), and a silent STATUS.md
  working-tree revert that briefly regressed main's copy (repaired). No
  tracked-file damage. **BUG (next cycle): multi-workspace init must scope
  device identity, not overwrite global.** OPEN: Mac daemon still runs as
  dev_932d7c02 (same account/keys; cosmetics) — adopt-and-revoke-orphans or
  restore: founder's call. Bench workspaces ws_79529b0d/ws_67eb29f6 (+2.5GiB
  R2) need server-side deletion. Dogfooding hazard noted: rbox syncing this
  repo can overwrite uncommitted working files during churn — commit docs
  promptly.
- **Gaps filed:** init publish doesn't render FirstPublishStats (folded into
  108); scan-stats accumulator double-count observed once (benign).

## 2026-07-12 evening — macOS perf sprint (founder: "sorted TODAY"); CI runners ate the disk (fixed)

- **APFS bulk-scan SHIPPED same-day (#241, design 107):** `getattrlistbulk`
  via bun:ffi behind `RBOX_SCAN_BULK=1` (darwin-only, per-dir readdir
  fallback on any FFI failure, flag-off byte-identical). Real-corpus Mac
  bench: warm full scan **5466ms → 3137ms p50 (−43%)**, per-file stat phase
  eliminated; parity 0 mismatches across 117k files + 20k-assert unit suite;
  independent fable-5 review no-blockers. LIVE on the Mac now (verification
  pass pending). Pre-default-on gate documented in design 107 (iCloud
  dataless + non-APFS mounts unverified; ATTR_CMN_FLAGS hardening spec'd);
  dircache composition = follow-up.
- **Design 104 CONFIRMED working in the field:** Mac log shows transient
  drop → suspect → "re-trusted after clean full-tree scan" → trusted. The
  ~11% idle I/O duty fix is real.
- **INCIDENT #2 (fixed in minutes):** the 8 self-hosted CI runner containers
  accumulated **~760GB** of writable layers from today's merge volume and
  filled the host disk to 100%. `docker compose up -d --force-recreate
  --scale rbox-core=8` reclaimed 732GB; 8/8 runners back online. FOLLOW-UP
  REQUIRED: runner job-workspace cleanup (ephemeral mode or work-dir tmpfs in
  ~/gh-runners/docker-compose.yml) so merge-heavy days can't refill it.
- **Commit accelerator running** (probe write/45s) to feed the design-102
  soak toward its sample gate; soak counters need a clean post-fence-fix
  window read before the enforce decision.

## 2026-07-12 evening — mark backlog DRAINED; soak collecting at full fidelity

- **Phase-1 drain complete (post-#239):** 228,962 marks purged / 117 passes /
  0 resurrected / 0 failed; **35.33GB accounting released**; marks table now
  191 rows; D1 shrank ~44MB. The freed refs cascaded into ~294k gc_candidates
  aging through the 7-day grace — the daily cron reclaims the R2 bytes
  automatically through ~07-19. Fence probe can never over-cap now → every
  commit contributes a real design-102 shadow compare. Check
  `/v1/admin/delta-soak` (or local AE SQL) for divergence before the enforce
  decision.
- **Propagation analyzer merged (#240)**: `bun scripts/propagation-report.ts
  <originLog> <receiverLog> [--sinceHours N]`.

## 2026-07-12 late afternoon — design 84 LIVE fleet-wide; first propagation statistics

- **Fold r3 (#238) verified on BOTH hosts:** Ubuntu `fold=evidence f0` 0.9s;
  **Mac `fold=evidence f0/f1` 0.4–1.5s** (was 16–21s receiver reads). §7.3
  gate (≤2s) PASSED fleet-wide. Mac writer resumed MDE (re-baseline snapshot
  then deltas). Watch: Mac RSS ~4GB post-bootstrap; ~11s unattributed server
  time on the Mac snapshot commit (delta-soak AE has the phase split).
- **First fleet propagation statistics** (`scripts/propagation-report.ts`,
  built via /tmp worktree — NOT yet committed to main; commit it): 233
  publish events / 12h, **publish→apply p50 16.7s** (post-r3 hour: 18.3s,
  n=30), 0 unmatched (zero staleness incidents — WS delivered every commit).
  Receiver p50 decomposition: notify≈0 + latest 1.5s + **rescan ~8–10s
  (Layer B target)** + apply/git + cycle luck. Origin ≈20s push (shadow tax
  ~7s dies at 102-enforce) + up-to-a-cycle queueing. Hand benchmark single
  samples (41.5s baseline / 60.2s collided run) are superseded by the
  analyzer's population stats.
- **Phase-1 mark drain root cause #2 (#239 merged):** purge blew the D1
  ~1,000-subrequest budget (one batch per row), threw mid-page AFTER
  committing ~707 deletions, and runPhase1 swallowed it as failed++ (which
  the script didn't print). Fixed: 33-row chunked batches, cursor persisted
  in finally, drain aborts loudly on repeated failures. Drain re-run in
  flight (expect ~2,000/pass, ~115 passes, releases ~35.4GB accounting).
- **In flight:** scan fault isolation + mass-delete circuit breaker +
  dev-install hygiene (`impl/scan-fault-isolation`); Mac fresh-publish
  benchmark via APFS-cloned `~/Development-bench` NEW workspace (founder
  suggestion — validates 99's encrypt gate + FirstPublishStats end-to-end;
  Mac has 160GB free, Ubuntu is 98% full so the clone lives on the Mac).

## 2026-07-12 afternoon — NEAR-MISS: phantom mass-delete caught pre-push; fold r3 merged

- **INCIDENT (caught, zero damage):** dev-install left a 92MB mode-000
  `.bun-build` temp INSIDE the workspace; the daemon scan EACCES'd hashing it
  and the failed scan surfaced as **"126,557 deleted"** — one push from a
  fleet-wide mass-delete manifest. Daemon wedged before pushing; stopped
  manually, temp removed, scan sane again. Fix cycle running
  (`impl/scan-fault-isolation`): per-file scan faults DEFER (never delete),
  scan-fatal fails the sync loudly, mass-delete circuit breaker
  (>max(20%,1000) files ⇒ abort push, explicit override only), dev-install
  builds outside the workspace. SCAN_PRUNE off fleet-wide meanwhile (Layer A
  exonerated — unrelated — but variables minimized).
- **Fold round 3 MERGED (#238):** evidence is now self-contained
  (GlobalManifestMeta carries gitRepos verbatim) — chronic git-repo deferral
  (the Mac's permanent worktree-branch state) no longer suppresses evidence;
  restores Mac fast pulls AND Mac delta writes. Fleet rollout of ec0b11dd +
  re-benchmark = next step.
- **Mark drain blocked by a second tooling bug:** dryRun honors graceMs
  (audit: 229,843 purgeable / 35.46GB releasable / 0 resurrect) but the LIVE
  path purged 0 — route-side graceMs handling fix in flight. Cron continues
  nibbling regardless; fence probe no longer cares about table size.
- Reverse benchmark (Mac→Ubuntu) was invalidated by the incident (Ubuntu
  daemon wedged mid-window).

## 2026-07-12 midday — gate-compression sprint (founder: "resolve the gates ASAP"; update STATUS continuously)

- **Gate 1 (84 fold) — round 2 PROVEN on Ubuntu; round 3 for the Mac.**
  #234 merged: the r1 fast path only matched +1-link head advances; daemon
  pulls are same-head or multi-link, so it never fired. Now evidence-as-
  prefix: same-head = ZERO fetches. **Ubuntu field-verified: `fold=evidence
  f0`, latest 0.9–1.0s (gate ≤2s PASSED; was 4.5s legacy / 8.5s broken).**
  Mac still coldwalks: its two chronically-deferred git repos (worktree
  branches — legitimate permanent state) suppress meta carriage via §3.4
  fail-to-snapshot, so evidence never forms there — round 3 running
  (decouple evidence from repo deferral). Flags currently ON fleet-wide on
  `1.1.0-dev+0a6e717`; Ubuntu healthy, Mac degraded-but-bounded (p≈5–6s,
  chain capped by snapshots).
- **Gate 3 shipped dark:** 85 Layer A merged (#236, `RBOX_SCAN_PRUNE` off) —
  honest bench: ~24% scan cut (readdir share only; stat floor remains; Layer
  B is the real O(actions) receiver win, future cycle).
- (superseded) **Gate 1 (84 fold) — round 2 required.** #233's per-fold perf fix WORKS
  (~600–800ms/fold, RSS bounded) but field validation failed AGAIN: the
  daemon pull path never engages evidence — `fold=coldwalk` on every pull on
  BOTH hosts, p growing with chain length (5.7→10.9s as ambient commits
  extend it). The #233 repro covered CLI pull(); the daemon loop differs.
  MDE flags rolled OFF fleet-wide a second time; fix round 2 running in the
  same cycle (daemon-loop repro is mandatory this time; multi-link
  evidence-forward folding too).
- **(superseded) Gate 1 (84 fold) — FIXED + re-deployed.** #233 merged: root cause was a
  bootstrap chicken-and-egg (fold evidence only persisted when WRITER caps
  were on → a FAST_PULL receiver cold-walked forever) + foldDelta
  canonicalizing the ~45MB manifest twice per fold (2k+1 materializations per
  walk = the 7–8.5s and the 8GB RSS). Now: evidence persists under FAST_PULL,
  streaming canonical hash (fuzz-proven byte-identical), trustedBaseHash
  threading (each manifest hashed exactly once; resultHash always
  recomputed), parallel prefetch + per-link buffer release. Bench (124k
  entries, CI-gated): fold 603–713ms (gate <2s), RSS +216MB → +18–80MB.
  New `fold=evidence|coldwalk|snapshot|raw` token on latest lines. Record:
  docs/design/106-manifest-fold-fix.md + REVIEW-106. **Fleet re-flipped**: both
  hosts on `1.1.0-dev+3628f0d` with full MDE flags; propagation re-benchmark
  in flight (baseline 41.5s; v1.1.0-broken-fold run was 39.6s).
- **Gate 2 (102 enforce) — soak was VACUOUS; unblock in progress.** New
  machine-readable soak endpoint `/v1/admin/delta-soak` (#232, platform
  secret; local AE SQL also works via CLOUDFLARE_ANALYTICS_TOKEN in repo-root
  `.env` + account id via API). First query revealed: **fallback
  fence_over_cap on 407/410 commits in 24h** — `blob_ref_candidates` has
  230,033 rows vs FENCE_SET_MAX 50k, so shadow compares never ran; zero
  divergence data is vacuous. Investigate+fix cycle running
  (`impl/102-fence-probe`): mark-lifecycle diagnosis (is 230k a hygiene bug?)
  + bounded/paginated probe per design §Q3. **Founder authorized removing
  stale prod marks if needed** (sole user) — any cleanup ships dry-run-first
  via a reviewed tool, main session executes. After the fix: soak accumulates
  for real; ~410 commits/day ambient → use a commit accelerator (cheap at
  605B/commit) then bring the founder the 72h-wall decision with data.
- **Gate 3 (85 Layer A) — dev cycle running** (`impl/85-layer-a`):
  ctime-keyed dircache pruned scans vs the ~10s/pull rescan; pruned scans
  return coverage:"pruned" via #229's plumbing (can never testify for watcher
  re-trust); ≥50k-file benchmark gate.
- Watchdog process runs whenever agents are active (5-min stall detection) —
  founder feedback 2026-07-12: supervision is the main session's job.

## 2026-07-12 morning — v1.1.0 shipped; design 84 fold FAILED its gate on the fleet (rolled back by flag); fix cycle running

- **v1.1.0 released + fleet upgraded** (both hosts, installer). Contents: design
  84 (#231, 15 commits, 5 review rounds), design 104 watcher re-trust (#229,
  dark; `RBOX_WATCHER_RETRUST=1` soaking on the Mac), GC cron enabled (#228),
  design 101 Phase 0 (#230), design 105 doc (#227), FirstPublishStats (#226).
- **Staged MDE rollout — measured live:** snapshot commit 40.5MB→7.1MB; the
  first delta commit shipped **605 BYTES** (seq 2102; u3.7s→0.2s). Writer side
  proven. BUT the receiver FAILED design 84's §7.3 gate: `latest` p-phase =
  **7.1–8.5s chain fold** (vs 0.3s legacy parse, gate ≤2s), FAST_PULL's
  persisted-evidence fast path did not engage on consecutive pulls, and the
  Mac daemon RSS hit **8.1GB** (baseline ~2GB). Net propagation benchmark:
  41.5s → 39.6s only. **MDE flags rolled OFF fleet-wide** (flag-off verified
  byte-identical; legacy latest back to 4.0s/p0.3). Fix cycle dispatched
  (`impl/84-fold-fix`): fast-path engagement bug, fold hot path ≤2s on a
  synthetic 124k bench, fold memory bound. Re-flip + re-benchmark after it
  lands.
- **Propagation baseline updated:** founder's Brian.md experiment = 41.5s
  (25.0s origin detect+push, 16.4s receiver); v1.1.0 warm run = 39.6s
  (18.3s origin, 21.4s receiver-with-broken-fold). Origin side is now
  gated on 102-enforce (acct 7.5–9.1s while shadow double-pays) + the fold
  fix; receiver on the fold fix + design 85.
- **Watch items:** commit `acct` elevated under shadow (expected until
  enforce); FirstPublishStats tokens live (`fp ready… redeem…`); Mac RSS
  after fold rollback (restart clears); log-forensics rule — never read
  daemon-log tokens without their timestamps (two false alarms this morning).

## v1.1.0 checklist (founder-directed: cut at the logic point, roll to fleet)

1. Gate-review + merge the overnight PRs as they land: design 84 impl
   (manifest deltas — the release centerpiece), design 104 impl (watcher
   re-trust, flag-gated), 101 Phase 0, 105 design doc.
2. Bump to 1.1.0 (package.json + CHECKED_IN_RBOX_VERSION), CHANGELOG entry,
   `release: v1.1.0` commit on main, tag `v1.1.0`, push; wait green.
3. Fleet: `curl -fsSL https://rbox.to/install.sh | sh` per host, restart
   daemons with `RBOX_PREFLIGHT_DELTA=1 RBOX_CRYPTO_FUSE=1` (+ any 84 flag
   after its own validation; 104's flag Mac-only after gate review).
4. **Re-run the propagation benchmark** (founder request): drop a single file
   in `~/Development` on one host, reconstruct the create/publish/apply
   timeline from both daemon logs (Brian.md baseline 2026-07-12 00:08Z:
   **41.5s** = 25.0s origin detect+push + 16.4s receiver poll+pull; seqs
   1860/1861). Compare and record here.
5. 102 shadow-soak divergence check needs the Cloudflare-Access admin
   overview or an AE token (platform secret does NOT reach AE) — founder
   cockpit look or token provisioning before any enforce flip.

_Prior entry (2026-07-11 evening): design 103 IMPLEMENTED + ROLLED OUT (#218 code, #219 flags): missing preflight 2.8–4.0s → **0.1s measured on the live fleet**; prod worker early-reject flag ON. Design-99 Phase-0: **GO — 86.8% encrypt cut [CI 84.1–87.7%]** (#220 merged; budget=96 MiB; determinism byte-identical; DOMINANT cost = concurrent streaming-zstd contention, not per-job overhead — Phase 1 gains a global fused-dispatch bound ~4–6; sync-zstd is 18× faster but address-breaking → parked as a separate founder decision). GC drain matures ~20:01Z._

## 2026-07-11 evening — design 103 built, validated, rolled out (same day as its design)

- **#218 (code, flag-gated default-off):** Part A server early stale-parent/
  epoch 409 (`RBOX_COMMIT_EARLY_REJECT`) + Part B client change-only preflight
  (`RBOX_PREFLIGHT_DELTA`), including the latent-bug fix (unsatisfiedBlobs now
  threaded through the reupload action; was dropped at sync.ts:464), the
  RECOVER_ACCUM_MAX=100k latch→chunked-full-audit, `RBOX_PREFLIGHT_FULL`
  escape hatch, and the design-102 coexistence regression pin. 4-round codex
  impl review to ALIGNED; /simplify + antislop clean; worker suite 420 pass
  both flag states; client suite 1242 pass (2 known host failures only).
  All implementation code written by codex (zero hand-written lines).
- **Real-workload validation (114k-file workspace, one-file pushes):**
  `missing` phase **2.8–4.0s → 0.1s**, `sent == introduced` exactly
  (`i/r/s/fa` counters in push lines), no fallback latches. Push wall
  19–22s → ~18s; the remaining wall is commit (~12s, design 102/84) + scan
  (~8s, design 85).
- **Rollout:** both fleet daemons rebuilt at `1.0.0-dev+2cb1ac5` and restarted
  with `RBOX_PREFLIGHT_DELTA=1` (env-var flag — a manual daemon restart
  without it reverts to full preflight, which is safe). #219 flips
  `RBOX_COMMIT_EARLY_REJECT=1` on dev+prod workers via wrangler vars
  (auto-deployed on merge; rollback = revert that line). Part A live
  verification pending a natural 409 (watch for `earlyReject: 1` in AE
  metrics / a fast conflict retry).
- **`/blobs/check` server-side cap deliberately NOT shipped** (client-first
  rollout per design §; ship only after fleet binaries are confirmed
  upgraded).
- **In flight:** design-99 Phase-0 A/B prototype (fused crypto measurement +
  budget selection per founder decision). Next queued: design 102
  implementation (shadow mode), design 84 C1/C2/D, 98/100/101 builds.

## 2026-07-11 — performance design day (all six audit-driven designs ALIGNED + merged)

- **Trigger:** codex sync-performance audit merged as #209
  (`docs/audits/2026-07-10-sync-performance-audit.md`, 15 findings). Founder
  framing that set priorities: **initial upload is THE conversion moment**
  (first-run experience), and passive-sync propagation matters equally.
- **Six designs drafted in parallel worktrees (opus agents, codex adversarial
  loops to ALIGNED), all merged:**
  - **98 first-publish pipeline** (#210, 6 rounds + 3 joint): encrypt→upload→
    receipt overlap; reservation-based disk backpressure; rolling
    server-satisfied check replaces the missingBlobs barrier; ReceiptDrainer
    redeems during upload. Attacks the 599s / 363s-encrypt first publish.
  - **99 fused crypto worker jobs** (#215, 6 rounds + 3 joint): byte-bounded
    multi-file jobs, in-memory ciphertext under a `CiphertextBudget`,
    ≥30%-encrypt-cut gate. **98↔99 seam reconciled in 3 joint codex rounds
    with both docs visible** — found consumer-spill + abort-bridge holes the
    single-doc loops could not see. Contract: 99 §10 normative
    (`CiphertextLease`, one charging authority, spill producer-only).
  - **100 fresh-join cold apply** (#211, 6 rounds): Git chain prefetch
    (gated on measured fetch stalls), directory-trie apply plan, size-aware
    lanes, base-exclusion model for case-collision entries. Attacks the 84s
    join / 34s Git phase.
  - **101 parallel multipart** (#212, 5 rounds, clean ALIGNED): pooled parts
    under a global byte budget; completion-reread characterized not weakened;
    found two pre-existing R2 orphan gaps (staging + row-less canonical) with
    lifecycle-rule fixes.
  - **103 steady-sync quick wins** (#214, 3 rounds): early stale-parent/epoch
    rejection (server) + change-only blob preflight (client). Found a latent
    bug: 422-recovery drops the unsatisfied SHA list (`sync.ts:464`) — must be
    threaded before any narrowed preflight ships.
  - **102 O(change) commit admission** (#216, 7 rounds, hardest design):
    server-computed parent→child refset delta (streaming two-pointer merge);
    carried-ref safety proven on the `blob_refs` durability invariant;
    off/shadow/enforce rollout with zero-harmful-divergence flip gate;
    fail-closed full-validation fallback.
- **First-ever measured prod commit decomposition** (#213, merged): #207's
  serverTimings were threaded but never rendered — 5-line formatter fix, live
  on the Ubuntu daemon. Zero-file push on ~114k blobs: POST p=7.9–8.6s →
  server 6.8–7.5s, of which **accountingMs 5.8–6.6s (~87%)** — audit Finding 1
  confirmed by direct measurement; design 102's motivation is now empirical.
  Also notable: **idle workspaces pay the full ~20s push cycle** publishing
  zero file changes (git-identity churn suspected — free win if spurious;
  flagged in #214 Q1).
- **Founder decisions recorded in-doc (#217):** 98 orphan entitlements
  ACCEPTED (lazy GC cleanup); 99 ciphertext budget prototype-decided; 100
  unrepresentable-entries indicator SHIPS in `rbox status` + dashboard; 101
  greenlit with synthetic multi-GiB rig validation.
- **Implementation queue (not started):** 103 (smallest, ships first —
  respect its 102-coexistence precondition), 102 shadow mode, 98/99 (Phase-0
  prototypes first per founder decisions), 100, 101. Design-84 C1/C2/D pairs
  with 102 for the ≤3–4s commit target.

- **Late-night additions (post-evening entry):**
  - **#206 GC drain hardening** — crash-robust lease release (3× backoff in
    finally), structured `gc_purge_failed` 500s, `retryAfterMs` on 409,
    paced `drain` mode in gc-drain.ts. Field-proven same hour: a mid-drain
    500 recovered on the next pass instead of a 50-min lease lockout.
  - **#207 design 97 (commit serverTimings)** — numbers-only per-segment
    breakdown (envelope/accounting/sidecar/commit/mirror/response) on every
    commit response + metric; clients nest it in commit phase details. This
    is the data feed for the design-84 commit-POST companion decision.
  - **#208 design 85 P0 instrumentation** — 4-round impl review; per-dir
    probe behind `RBOX_SCAN_PROBE=1`, deep-scan drift audit (settle-
    transaction evidence protocol, quiescence provenance, oldest-wins dedup
    cap 500, fail-soft path-free sidecar), scan-site stats, and
    **RBOX_METRICS default-ON** (opt-out `RBOX_METRICS=0`; measured worst-
    case scan overhead 0.4–3.1%).
  - **Drain end-state:** ALL 5,410 grace-eligible intents stamped (verified
    in D1; lease released clean). Deletes mature from 2026-07-11 ~20:01Z —
    run `bun scripts/gc-drain.ts drain` (secrets: prod-keys.local.secret),
    verify ~5,410 purged + bytes, then flip RBOX_GC_PURGE_DISABLED.
    Remaining ~64k candidates age past 7-day grace through ~07-15.
  - **Fleet soak LIVE:** both daemons on dev build `1.0.0-dev+16fea15`
    (backup at `~/.rbox/bin/rbox-1.0.0.bak` on each host; next release
    supersedes). Collecting P0.1 stats + P0.3 drift + design-97 timings
    passively. NOTE: the Mac's rbox-core checkout sits on old branch
    `Codex/perf-improvement-search` with a modified AGENTS.md (not touched;
    soak build came from a /tmp/rbox-soak-main worktree at origin/main —
    remove when convenient).

## Where we are

- **2026-07-10 evening sprint (5 PRs merged, all via subagent+codex tracks):**
  - **Design 84 v7 ALIGNED** (#201, 6 codex rounds, zero final findings) then
    **Phase A measured** (#204, gate record in doc §6.1): the 39.2MB
    O(workspace) manifest transfer is confirmed, BUT `postMs` (the commit
    POST — server-side full-refset pipeline) dominates at 8.4–8.6s of the
    ~14s commit (56–63%); upload is only ~4s. **C1-alone FAILS its gate;
    commit ≤3–4s targets unreachable without a server-side O(change)
    commit-POST companion design (unwritten; next step = OpSpan decomposition
    of a commit). Phase D (fast pulls, ≤2s) stands; C1 still pays for bytes
    (39.2→~5MB).** Fleet daemons now run `RBOX_METRICS=1` permanently.
  - **Design 85 v3 ALIGNED** (#202, 7 codex rounds; Layer B rebuilt around the
    design-93 mutex, dircache reuse keyed on directory ctime) and its two
    **prerequisite correctness ships MERGED** (#205): torn-scan stability
    predicate (`statsStableAcrossHash`: ino/dev/size/mtime/ctime/mode across
    the hash) + HashCache v2 `(mtime,size,ctime)` with versioned format.
    Deliverable 2 (P0 instrumentation) in flight; founder directive: flip
    RBOX_METRICS default-ON if measured overhead is negligible; all new
    instrumentation output must stay path-free/non-PII.
  - **CLI usability audit landed** (#203): audit doc at
    `docs/audits/2026-07-09-cli-usability-audit.md` + 4 fix batches —
    `restore` now trash-tier-backed (undoable), uninstall keystore warning,
    doctor/connect/recover/sync paper cuts, `friendlyHttpError`, help
    coverage, global unknown-flag detection. Ships to fleet at next `v*`.
    Deferred product calls listed in the final PR body (config-only settings
    CLI surfaces, env-var flag parity, account/pair/connect disambiguation).
- **GC drain (design 95/96) — Phase 1 LIVE in prod, deletes unlock 2026-07-11
  ~20:01Z.** Timeline 07-10: #200 deployed 19:19Z → DO index backfill done
  <40min → first-ever successful Phase 1 mark at the 20:23Z cron (38,313
  entitlement rows) → dry-run audit walked all 504 pages: 70,040 candidates
  (~61.3GB), wouldIntent 5,410 (7-day grace gates the rest; they age in
  through ~07-15), wouldDelete 0 → **1,400 delete intents stamped** via
  supervised `gc-drain.ts execute` passes. **Known bug found: an execute
  invocation that 500s (likely D1/subrequest exhaustion under rapid passes)
  opens its 200 intents but orphans its lease → 20min TTL + 30min takeover
  quiescence ≈ 50min lockout; recurs every few invocations.** Runbook
  2026-07-11: `wrangler tail` from the Mac during one execute to capture the
  exception → fix (incl. crash-robust lease release) → verify the 1,400
  delete after quiescence → stamp the rest → THEN flip
  `RBOX_GC_PURGE_DISABLED` for the daily cron. Secrets:
  `prod-keys.local.secret` at repo root (rbox-synced to both hosts) has
  `RBOX_PLATFORM_SECRET`; usage string in the script header. Pace executes
  ≥60s apart.

- **Version: v1.0.0 — the correctness milestone (2026-07-10).** No functional
  change over 0.9.18; the tag marks designs 91/92/93 field-proven. Release run
  went green first try (6m41s, no gate flake). Live on Mac + FM daemons.
  ~~Open: via-desktop-ubuntu daemon DOWN post-upgrade~~ **RESOLVED same day**:
  its credential was the agent PAT (`agent_7Z8R70…`) revoked in the 07-09
  roster cleanup (old daemon survived on a pre-revocation session). Re-enrolled
  via headless pairing — `rbox pair` on the Mac → `RBOX_PAIR_TOKEN=… rbox login`
  on Ubuntu (env-var redemption, `src/cli/auth-cmd.ts:184`) — now device
  `dev_fdca6ca3…`, daemon healthy on 1.0.0. Roster note: the host's previous
  device entry (`dev_df5d3b6c…`) is now orphaned; revoke at next cleanup.
- **CHANGELOG.md is now the full record** — backfilled v0.1.0 (2026-06-29)
  → v1.0.0, all 51 tags, first commit 2026-06-26. Keep it current per release.
- **Design 35 (client phase metrics) doc header was stale — it SHIPPED** in
  v0.4.3 (#17) + designs 83–85 phase-0 (#161/#165): `src/engine/phase-report.ts`,
  `src/cli/metrics.ts`. The measurement gate for designs 84/85 is already met.
- **Steady-state sync latency, measured end-to-end 2026-07-10:** a 103-byte
  file took ~42s Linux→Mac (24.6s write→publish + 17.1s publish→applied, WS
  connected the whole time — no fallback path involved; both legs are
  O(workspace) machinery). Design 84 (manifest delta encoding) is the marquee
  lever, targeting the 13–17.5s commit envelope + 2.2–7s pull `latest`;
  design 85 (scan) and 39/74 (pull apply) follow. Deliberately deferred past
  1.0 — perf is the 1.1 track.

- **Migration numbering hardened (#196, 2026-07-10):** the duplicate-number
  pairs (0014×2, 0016×2) are verified applied in prod + dev in lexicographic
  order — frozen forever (wrangler tracks by filename; never rename). New
  collisions now fail the test suite at config time; rules in
  `apps/api/migrations/README.md` + root CLAUDE.md pointer.
- **Host-env notes (via-desktop-ubuntu, 2026-07-10):** `GITHUB_TOKEN` in
  `~/.profile` was stale (shadowed valid gh keyring auth) — replaced with the
  keyring token. `node_modules` installed for the first time (was binary-only).
- **Version: v0.9.17** (live fleet-wide 2026-07-09: Mac + FM daemons in sync; via-desktop-ubuntu binary-only). First release run failed on a flaky retry-exhaustion test (#188 fixed: explicit 30s timeout; jittered 5-attempt backoff can exceed bun’s 5s default) — tag was moved to the fixed head. Fleet = Mac (`dev_932d7c…`, primary
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

- **Version: v0.9.18** (live fleet-wide 2026-07-10: Mac + FM daemons + Ubuntu
  binary). Ships design 93 (#192) + field-driven hardening: bounds 64→512
  keys (#193), reader-side config invalidity IGNORED never pull-fatal +
  bounds-in-fingerprint cache invalidation (#194), crypto-pool test
  isolation (#195, ledger item closed). Release-gate flake pattern repeated
  (tag moved to fixed head, same as v0.9.17).
- **savvy-core needs-resolution conflict: RESOLVED 2026-07-10 midday.**
  Root cause: overnight pulls deferred while BrianVia/arch-raw-error-records
  (PR #756, merged) was checked out in a linked worktree; the residual
  divergence had decayed to ONE missing deploy tag. Fix: tag-aligned local
  to head, removed the stale worktree + branch (local + GitHub). Marker
  cleared on the next cycle; savvy-core's config (74 keys) is at head —
  the lane's hold-then-self-heal behavior worked exactly as designed.
- **RboxBar** rebuilt from main and relaunched on the Mac: carries #190
  (workspace size display, from a parallel session) + #185 (dropdown UX).
  Reminder: the bar app ships by local rebuild (`macos/RboxBar/scripts/
  bundle.sh` → copy to /Applications), NOT via the CLI release.
- **Design 93 (git config sync) — SHIPPED v0.9.18.** The
  2026-07-10 deal-breaker (rbox-materialized repos have no remotes/tracking;
  ~90/host found on Ubuntu, 179 hand-healed) is closed permanently:
  allowlisted `remote.*`/`branch.*` keys travel in the encrypted git
  section, fill-only apply, self-healing presence rule. 11 adversarial
  design rounds (REVIEW-93.md in the d93 worktree); new infra: reusable
  lockfile primitive, transactional per-repo state CAS, workspace sync
  mutex (also retires the pre-existing daemon-vs-CLI sync race). Live rig
  gate PASS (materialize/heal/propagate/zero-echo; runs/20260710-071943).
  Post-merge, pre-release: GATES.md Lane 2 — RC scratch-join on
  via-desktop-ubuntu incl. a real-GitHub probe repo — then fleet upgrade.
  Rig now grants dev plans (design-86 fix) + validates container mounts.

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

- **Repo hygiene (2026-07-09):** 40 stale worktrees removed (43→2 + primary), 65
  shipped local branches deleted, remotes pruned. Dirty work was preserved on
  branches first: `heal-hotfix-poison-skip` (emergency skip patch, committed),
  `feat/dev-install` (unshipped feature), `web-dashboard-rebuild`,
  `release-v0.9.8`, `feat/front-door`. ~81 local branches remain
  (squash-shipped-but-unverified; optional deeper pass).

## Active: storage-quota & GC program (opened 2026-07-10, founder decisions locked)

Plan from the 2026-07-10 deep-dive (three subagent reports + live prod numbers:
145.4 GiB blobs stored vs 83.1 GiB referenced, ~62 GiB dead, 70k condemned
candidates never purged). **Founder decisions (2026-07-10):**

1. **Purge automation: REVERSES the design-33 standing decision** ("Phase 2
   stays off the cron", `worker.ts:106-110`). Approach = cron with narrowing
   gates per design 33 §3.3 — receipts-path candidate-aware validate (the
   real hole), R2 object-age gate re-read at delete, days-long grace —
   accepting the residual milliseconds-wide TOCTOU. The DO delete-barrier was
   considered and rejected (hot-path tax + new availability surface for a
   ~zero-probability, self-healing event).
2. **Cadence: daily purge, 7-day grace.**
3. **IA tiering: GO, history blobs >30d old** — explicit CopyObject class
   flips from the reachability job (R2 lifecycle rules are prefix-only and
   can't see reachability); never tier blobs due for retention-prune within
   30d (IA minimum billing). Verified 2026-07-10: IA $0.01 vs $0.015/GB-mo,
   retrieval synchronous, $0.01/GB fee.
4. **Design 89 params confirmed as drafted**: quota = live bytes, K=4
   stuffing bound (thin-don't-block), retention solo 30d / pro 365d / team
   90d, Team pooled-storage question deferred until Team ships.

Sequencing: design 95 (purge automation) → design 89 implementation (live
ledger + quota flip + surfaces) → IA tiering rider. Phase-0 copy fix (§7,
90→365) verified ALREADY LANDED (README/pricing.md/plans.ts all 365).
Design 89 §6 named ~07-15 as the purge review date — resolved early, above.

- **INCIDENT 2026-07-10 (afternoon): WorkspaceSync DO OOM on `/roots` —
  CONTAINED (#198, merged → prod).** Root cause: `/roots` materializes every
  retained sequence's full refset (~102k refs × 1,070 seqs ≈ 6.85 GiB JSON)
  in a 128MiB DO — deterministic OOM ~8-14 seqs in, every hourly GC tick;
  fleet WS connects died in the same isolate resets (this was the morning's
  WS-churn mystery). Design 24 predicted this and prescribed a never-built
  bound. Containment: fail-closed 503 `roots_too_large` (64 seqs / 500k refs
  caps) — GC stays unavailable-but-safe for the big workspace; WS stability
  restored. Full diagnosis: session scratchpad roots-oom-diagnosis.md.
  **Follow-ups (blocking the manual GC run + design 95): paginated
  snapshot-bounded `/roots` (fast functional fix), then a durable
  retained-root index (steady-state; replaying every retained commit is the
  wrong algorithm for 365d history).**
- **Design 94 (signin_method): SHIPPED** — ALIGNED after 7 codex rounds,
  implemented, merged (#197); prod migration 0023 auto-applied, dev applied.
  Founder row backfills on next dashboard login.
- **Design 95 (GC purge automation): MERGED (#199, 2026-07-10 evening),
  SHIPS DISABLED** (`RBOX_GC_PURGE_DISABLED=1` both env blocks; migration
  0024 auto-applied to prod incl. the fence triggers — those + validation
  steering are ACTIVE and wanted). 10 adversarial rounds; REVIEW-95.md is
  the ledger. Protocol: RAISE-ABORT publication fence + checkTime-anchored
  receipt authority (12h TTL < 24h intent quiescence — no authority spans
  a delete) + two-phase delete w/ verify-after-delete + lease-guarded
  fence drops. 371 API tests incl. the full race matrix;
  `scripts/gc-drain.ts` is the supervised drain tool.
- **Design 96: MERGED (#200, 2026-07-10 night)** — implemented same
  session (409 API tests first-run green incl. the index-vs-brute-force
  property test), post-merge CI green on main. Prod backfill starts via
  DO alarms once Workers Builds deploys (~1,241 seqs on the primary
  workspace, ~25 MiB/fold, 5× under FOLD_MAX_REFS). The §6.2 250k-scale
  rig gate is DEFERRED until any commit-admission cap change (field max
  102k). **REMAINING ROLLOUT (founder-supervised): watch index_state →
  ready (503 index_building until then; GC Phase 1 starts completing) →
  dry-run audit (expect ≈62 GiB / ≈70k) → scripts/gc-drain.ts → flip
  RBOX_GC_PURGE_DISABLED → design 89.** Then: designs 84/85 revision
  loops (founder-confirmed next after 96's merge; round-1 ledgers on
  their branches). Prod facts checked tonight: exactly ONE workspace row
  (ws_2b6e15da/root, 1,241 commits) — the founder IS the whale; the
  lingering old-workspace data is the unreferenced-blob layer (the drain
  target), not workspace rows.

- **Designs 84 + 85 staleness reviews (2026-07-10 evening): both REVISE,
  materially stale vs current main** (branches `design/84-review` /
  `design/85-review`, REVIEW-84/85.md). Design 84's headline: its recovery
  story is IMPOSSIBLE post-design-91 (head authority rejects the
  fresh-snapshot escape; a broken delta chain wedges every writer), its GC
  chain-rooting invariant is unenforceable as written, and its Phase-0
  plan describes building instrumentation that already shipped. Design
  85's headline: design 93's workspace mutex materially changes Layer B's
  daemon-delegation shape, and Layer A must not start before the P0
  measurements. **Both need full revision loops (fresh session — they are
  design-94/95-scale efforts) before the 1.1 perf track implements.**
- **D1 scaling posture (discussed 2026-07-10):** ship design 32's
  `dbFor(accountId)` seam at N=1 EARLY (behavior-preserving refactor,
  founder decision gating: split vs placement-constraint), define shard
  tripwires (D1 >2-3GB, recurring hot-path 429s, cron budget alarms),
  keep design 57 (PlanetScale) break-glass for >10TiB whale accounts.
  Ratio: metadata ≈ 1MB per GiB content ⇒ one D1 ≈ 10TiB content.
- **codex fast mode enabled on via-desktop-ubuntu** (`service_tier="fast"`
  + `[features].fast_mode`, ~2.5× credit rate; smoke-tested on
  gpt-5.6-sol).

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
- Surface the web login's auth provider (Google OAuth vs password) in
  `rbox account status` + dashboard: capture `external_accounts` from the
  Clerk user fetch (`apps/api/src/notify.ts:269` already makes the call) into
  `clerk_users`, return it from account status. Today D1 stores only the
  email; auth method is invisible outside the Clerk dashboard. Fleet account
  is `brian.via.dev@gmail.com` (`acct_b4e0b81…`) — the ONLY prod web account;
  a browser session on any other identity would silently create a fresh one.

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
- **Fleet network speeds (measured 2026-07-13, raw R2 curl probes — know these
  before blaming rbox for throughput):**
  - **via-desktop-ubuntu**: Ethernet to a MESH NODE (wireless backhaul), NOT
    wired-to-WAN — caps **~155 Mbps up** (single stream ~158, 4-parallel ~155
    aggregate; parallelism buys nothing, the backhaul is the cap). Never use it
    for bandwidth benchmarks.
  - **flat-meadow-prod-main-01**: wired ~gigabit — single stream ~300 Mbps,
    **4-parallel 632 Mbps aggregate**. THE bandwidth/perf benchmark host
    (16T/32GB).
  - **Mac (dfinitiv-macbook-pro)**: uplink only ~40 Mbps — network-bound for
    uploads; fine for scan/watcher/propagation tests, useless for upload
    ceilings.
  - Rules: benchmarks run SERIAL, one host at a time (don't split one host's
    pipe across concurrent runs); bench against `~/code` snapshot clones
    (desktop + FM), never live workspaces; run a raw curl/R2 probe first so
    network ceiling vs software ceiling is settled before interpreting rbox
    numbers (that's how the universal ~35 Mbps uploader ceiling was isolated
    as software, not ISP).
- Cloudflare Flagship (blog.cloudflare.com/flagship) — founder-flagged for future exploration, NOT current work.
