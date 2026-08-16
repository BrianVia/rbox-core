# rig — the design-56 test bench (P0)

Two ephemeral Linux devices, a throwaway account, real onboarding + convergence
against the **dev** worker — so a change can be validated before it ships, on data
that looks like a working machine, without risking one. This is the stability net
that the 2026-07-01 mass-delete and the 2026-07-02 conflict storm were found *by
bleeding on*. Full designs: [`docs/design/56-test-bench.md`](../../docs/design/56-test-bench.md)
and [`docs/design/131-rig-runtime-backends.md`](../../docs/design/131-rig-runtime-backends.md).

**P0 delivers:** `doctor` / `up` / `run onboard-smoke` / `down`, the device image,
`source` CLI mode, and the `onboard-smoke` PR gate. Prod is refused before any
container starts; every resource the rig creates is namespaced `rig-*`.

## Requirements

- macOS 26+ on Apple silicon with [Apple `container`](https://github.com/apple/container)
  v1.0.0, or Linux with a local Docker 24+ daemon. Remote Docker contexts are refused
  because the daemon must resolve this checkout's bind paths.
- `bun` on the host.
- A dev bootstrap secret: env `RBOX_DEV_BOOTSTRAP`, or a line
  `RBOX_DEV_BOOTSTRAP_SECRET=<secret>` in `dev-keys.local.secret` at the repo root.
- The dev platform secret: env `RBOX_DEV_PLATFORM_SECRET`, or a line
  `RBOX_DEV_PLATFORM_SECRET=<secret>` in that same repo-root secret file.

The secret file is gitignored; in a worktree the rig also probes the primary
checkout. Secret values are never printed.

Run `bun run rig doctor` first — it checks all of the above and prints fix-it
commands. On a clean Docker host it builds the scoped rig image, then creates and removes
one namespaced transient container to prove read-only binds, resource limits, and daemon
networking actually work.

## Usage

```bash
bun run rig doctor              # host preflight (read-only; exit 1 if anything is ✗)
bun run rig up                  # build the device image + start rig-dev-a / rig-dev-b
bun run rig run onboard-smoke   # the PR gate: bootstrap → init → pair → join → push/pull → assert
bun run rig run all             # FAST suite, including SQLite genesis + JSON upgrade paths
bun run rig down                # stop+delete containers + network
bun run rig down --all          # also delete the rig-device image + rig-* volumes
bun run rig gc                  # scoped dangling artifacts + old runs/workload cache
```

Flags: `--runner container|docker` (overrides `RBOX_RIG_RUNNER`, then the platform
default), `--api-url <url>` (overrides `RBOX_API`; prod is always refused),
`--keep-account` (skip the per-run `DELETE /v1/account` teardown), `--all` (see above).

The rig labels Docker-owned resources `rig=1`; cleanup never invokes a global Docker
prune. `up` retains the newest 30 run directories, and `gc` also enforces the workload
50 GiB cache cap. Doctor hard-fails below 20 GiB free and reports Docker builder-cache usage.

### What `onboard-smoke` does

1. **A** `rbox login --bootstrap` (secret injected by env, never argv), then the rig
   grants the throwaway account a `pro` plan through the dev-only admin endpoint.
2. **A** seed a ~100-file deterministic corpus (`scripts/bench/corpus.ts`, shape
   `tiny`) + a symlink (historic regression shapes: empty, duplicate, symlink).
3. **A** `rbox init --new`; read the workspace id from `.rbox/workspace.json`.
4. **A** `rbox push` (`RBOX_UPLOAD_CONCURRENCY=16` — the design-34 WAF rail).
5. **A** `rbox pair` → require and parse the emitted `rbox connect <token>` command.
6. **B** execute that canonical one-shot connect path (token redacted in artifacts).
7. **B** `rbox init --workspace <id>` + `rbox pull` (`RBOX_DOWNLOAD_CONCURRENCY=16`).
8. **Assert** both state stores carry a SQLite authority created by genesis (not
   migration), then assert A and B trees are byte-identical (excluding `.rbox/`),
   file count > 90, and the empty file + symlink survived.
9. **Teardown** host-side `DELETE /v1/account` with A's own owner creds (a live
   exercise of the design-37 deletion cascade). Skipped with `--keep-account`.
10. Write `report.json` + a PASS/FAIL table into the run dir.

## Run artifacts

Each run writes `scripts/rig/runs/<yyyymmdd-hhmmss>-<scenario>/` (gitignored):

- `run.log` — every step + assertion, timestamped.
- `report.json` — runner, steps (with durations), assertions, and scenario verdict.

Exit code: `0` PASS, `1` FAIL, `2` usage/unknown scenario.

## Architecture (P0)

- `rig.ts` — entry; hand-rolled arg parse; `doctor` / `up` / `run` / `down`.
- `lib/config.ts` — names/paths, `assertNotProd` (the prod rail), URL + image-hash resolvers. **Pure.**
- `lib/container.ts` — the **only** module that spawns Apple `container` or Docker
  (+ host probes for `doctor`); owns backend argv/parsing and runtime readiness.
- `lib/device.ts` — a `Device` handle: `rbox` / `exec` / `readFile` / `writeFile` / `seedCorpus`.
- `lib/convergence.ts` — in-guest `find`+`sha256sum` tree fingerprint; A-vs-B compare (excl `.rbox/`). Pure builders/parsers.
- `lib/account.ts` — bootstrap-secret resolution (redacted) + host-side account teardown.
- `scenarios/` — `types.ts` (contract + report shaping), `index.ts` (registry), `onboard-smoke.ts`.
- `Dockerfile` — ubuntu:24.04 + pinned bun + baked linux-arm64 `node_modules`; `src/`+`scripts/` bind-mount at runtime.

Tests (`bun test ./scripts/rig/`) cover only the pure logic: the prod refusal, the
image-staleness hash, secret-resolution precedence + redaction, the fingerprint
parse/compare, the pair-token parse, and report shaping.

### SQLite authority dimension (SP-2.5)

Every scenario in `FAST_SUITE` that uses the shared two-device preamble now reads
state through the dual-authority state view and requires both databases to carry
`migration_completion.origin_kind = 'genesis'`. The marker alone is not enough: a
migrated legacy workspace also has that marker.

Two FAST scenarios pin the lifecycle edges:

- `sqlite-fresh-install`: bind-only `track` publishes genesis Q before sequence
  0's first sync → pair/track/genesis a second device → converge.
- `json-upgrade-path`: install an existing JSON-authority fixture through the
  compatibility/test writer, sync it without conversion, pair a genesis-SQLite
  peer on the same build, round-trip B→A, and require convergence while A remains JSON.

### `chaos-restart` (explicit-only — design 56 §9)

A device that CRASHES mid-push must recover cleanly. Kept OUT of the FAST suite not on
wall time (a live run lands ~30s) but on flake posture — it SIGKILLs + restarts a guest,
and Apple `container` 1.0.0 can wedge on kill/start, which doesn't belong in the every-PR
gate. Run it by name (and nightly):

```bash
bun run rig run chaos-restart
```

1. Onboard (git-sync OFF), seed ~400 × 256KiB random files, **no** push yet.
2. **A** start `rbox push` DETACHED (`RBOX_UPLOAD_CONCURRENCY=4`, redirected to
   `/work/push.log`) → poll the log until the **upload** phase is clearly underway.
3. **HARD-KILL** the guest mid-push — `container kill --signal KILL rig-dev-a` (a
   crash, no grace). (Kill variant shipped: **VM-kill**. The in-guest `pkill -9`
   fallback exists only for a wedged runtime; whichever ran shows in the step names.)
4. `container start rig-dev-a` → wait for exec-ability → probe `RBOX_API` came back
   from the container config → assert `.rbox/state.json` isn't corrupted.
5. **A** resume `rbox push` (foreground) — design-23 receipts + idempotent commit make
   it clean; assert exit 0 and **no** mass-delete/reconcile guard refusal.
6. **B** pull → assert SYNCED-SET convergence (manifest ∩ disk, like
   `conductor-initial-sync`) → teardown 2xx.

### `git-entanglement` (FAST suite — design 56 §9)

The design-43 regression net: **sync must never corrupt or entangle real git state
across devices.** Builds two real git repos on A and asserts git-LEVEL integrity on B.
Deterministic (fixed git identity + commit/tag dates → stable shas), no guest kills, ~16s
of work — so it rides the every-PR `rig run all` gate.

```bash
bun run rig run git-entanglement
```

1. Provision (git-sync **ON** — the §28 default). Before `init`, build on A:
   - `repo-top/` — dir-repo: 3 commits on `main`, a `feature` branch (+1 commit), an
     annotated tag `v1`, a tracked file **modified-but-uncommitted** (dirty worktree),
     and an **untracked** file.
   - `nested/deeper/repo-inner/` — an independent nested dir-repo, 2 commits, one branch.
2. Push on A → B joins + pulls. Git state travels as **E2EE-encrypted `git bundle`
   artifacts** in the manifest's `gitRepos` map (`.git/` is hard-excluded from plain-file
   sync); the working files travel as ordinary plain files.
3. **Assert on B, per repo:** `git fsck --strict` clean · HEAD symbolic-ref + sha equal
   A's · `git for-each-ref` (branches + tags) byte-identical to A · `git log --format=%H`
   on `main` identical · the two repos stay **independent** (repo-inner's refs/HEAD
   converge too — no cross-repo bleed).
4. **Dirty/untracked semantics** (pinned from design 43 §12/§5): the modified tracked
   file + untracked file arrive via plain-file sync; B restores A's index verbatim, so
   `git status --porcelain` is **identical** on both sides (` M a.txt` + `?? untracked.txt`).
5. **Churn:** A switches `repo-top` to `feature`, adds a commit, pushes; B pulls;
   re-assert fsck + ref equality + HEAD now on `feature`.
6. Manifest convergence (the plain-file half) closes it out.

### `worktree-squash-lifecycle` (explicit-only — **EXPECTED RED until design 200 lands**)

Design 200's acceptance gate, as the founder ruled it: a full agent lifecycle — **create
worktree → branch → commit → squash-merge to main → delete branch + worktree — with zero
surviving deferrals.** It is red BY CONSTRUCTION on current main; the failures are the
spec. Not in `FAST_SUITE` and deliberately not reachable from `e2e.yml`'s default `all`,
so a known failure never gates a PR.

```bash
bun run rig run worktree-squash-lifecycle
```

Acceptance semantics: **the clearing event is worktree DELETION, not the squash-merge.**
While a worktree holds a branch, holding that one ref is legitimate — something genuinely
has it checked out. Two phases follow from that:

- **Phase 1 (worktree alive, branch squash-merged)** — design 200 P2's *no-escalation*
  contract. The per-ref hold is allowed; escalating it is not. Asserts no whole-repo apply
  deferral, no carried `pending` (the capture gag at `src/cli/sync-git/apply.ts:1447-1450`),
  that an unrelated incoming ref still applies, and that an unrelated commit on `main`
  still propagates A→B.
- **Phase 2 (after `git worktree remove` + `git branch -D`)** — the gate proper: zero
  deferrals on both devices within 4 explicit round-trips *and* across a bounded
  live-daemon settle window, refs converged, and **no phantom** `refs/heads/…` left in
  A's persisted BASE/`pending`. Plus the field's two error signatures:
  `branch transition does not match logical BASE pre-state` (never legitimate anywhere)
  and `is checked out in linked worktree` (legitimate only while the worktree lives, so
  that check is windowed to after its removal).

Two fixture details are load-bearing and were learned by running it:

1. **The ownership hold is only reachable with a diverging peer.** `follow.ts` skips any
   candidate whose incoming value equals its local value, so a repository whose only
   writer is A never fires the hold. The rig does what the fleet does: the agent keeps
   committing in its worktree (`--allow-empty`, a ref-only advance that keeps A's tree
   clean so the reason stays `worktree-ownership` and not `local-edits`) while the peer
   publishes unrelated Git work.
2. **The gag must still be outstanding when the branch is deleted.** Design 174
   supersession heals the hold once A's local history subsumes the carried section, so the
   scenario re-arms the gag immediately before `git worktree remove` + `git branch -D`.
   That ordering is design 200 §1.5's mode (a) → mode (b) bridge and is what turns the
   deletion into a phantom rather than a clean retirement.

Note the surface asymmetry it exposes: `rbox push` has no `onGitLog` wiring
(`sync-cmd.ts:19` is pull-only, and `--verbose` is a pull-only flag), so the **capture**
lane's per-repo forensics exist only in the daemon log. That is why the scenario ends with
a live-daemon soak and asserts on both devices' daemon logs.

### `git-rebuild-settlement` (explicit-only — **BUG-PINNED: green while #752-B is live**)

The two-device-rebuild reproduction three parked items asked for (GH #752 defect B,
#647, design 236 §3.2c). Unlike `worktree-squash-lifecycle`, its assertions describe
the CURRENT defective behavior — it PASSES today and goes RED when p-settlement is
fixed, which is the flip it exists to force. Every pinned assertion is prefixed
`[BUG #752-B]`. Kept out of `FAST_SUITE` and out of every CI workflow: a scenario
that goes green on a live defect must never gate a PR.

```bash
bun run rig run git-rebuild-settlement
```

1. A seeds a git repo; both devices converge (B serializes a BASE).
2. A publishes a NEW branch, B pulls — the negative control: an ordinary follow
   writes a present artifact (P) and retires it in-flight, leaving zero standing P.
3. **The rebuild** (the 2026-08-15 desktop/Mac shape): B renames `.rbox` aside and
   re-tracks the SAME non-empty directory with `rbox track --workspace <id>`. No
   state, no BASE, every git repository still on disk.
4. A publishes a second NEW branch. B's next pull must follow a ref with no prior
   BASE value into a record with no BASE at all: P is written, settlement holds,
   and the repo can never earn the BASE it needs to settle that P.
5. Asserts the loop: `git-sync deferred <repo>: P settlement BASE disappeared` on
   consecutive pulls with a frozen `deferredSince`, a standing P every cycle, and
   `rbox git resolve <repo> take-theirs` refusing identically on repeat.

Recorded deviations from the field notes: take-theirs surfaces the REAL reason here
(the `artifact` refusal), not the `could not complete safely` catch-all the Mac saw;
and #647's boundary self-invalidation is NOT reachable from this fixture, because a
standing P makes resolve's artifact preflight refuse before the locked boundary is
ever reached. #647 needs its own fixture (dirty worktree, no standing P).

### CI — `.github/workflows/e2e.yml`

Manual (`workflow_dispatch`, input `scenario`, default `all`) + nightly
(`schedule`, ~02:00 San Diego). Targets a **self-hosted** `[macOS, ARM64]` runner —
**none is registered yet**, so the job queues/skips until the founder registers one
on the M2 Max (GitHub-hosted runners can't do macOS 26 + vmnet — design 56 §11). Set
the `RBOX_DEV_BOOTSTRAP` repo secret (and optionally `CLOUDFLARE_ACCOUNT_ID` /
`CLOUDFLARE_API_TOKEN` for the AE channel) before the runner goes live.

## Compiled candidate override

`up` and `run` accept `--binary` with an exact canonical absolute path:

```sh
bun run rig run onboard-smoke --binary /absolute/path/rbox-linux-arm64
```

`--binary` remains the both-device shorthand. `--binary-a` and `--binary-b`
override it for one device:

```sh
bun run rig up --binary-a /absolute/rbox-1.11.0 --binary-b /absolute/rbox-2.0
```

The rig validates every supplied path as a regular, non-symlink executable before
creating a container, copies each exact artifact into its own content-addressed
single-file staging directory, and bind-mounts the selected directory read-only at
`/opt/rbox/bin` in that guest. Every foreground, shell-mediated, and detached
scenario invocation uses that fixed executable. Omitting an override preserves
the source-mode image shim.

Runs persist A and B mode, SHA-256, observed `rbox --version`, and compiled host
path in `report.json` and `report.md`. Different effective binary contents are
refused unless the scenario explicitly declares dual-binary support; a declared
differential also fails before scenario assertions if both guests report the same
version. `dual-binary-state` is the one declared differential gate. Run it with
released 1.11.4 on A and the exact candidate on B:

```sh
bun run rig run dual-binary-state \
  --binary-a /absolute/path/rbox-1.11.4-linux \
  --binary-b /absolute/path/rbox-candidate-linux
```

The runner persists both canonical host paths, SHA-256 values, and observed
versions. The SP-2.5 `sqlite-fresh-install` and `json-upgrade-path` scenarios
remain same-build gates.

## What's next

Perf budgets flip from report-only to gating once burn-in data exists. See
design 56 §13 for the phase breakdown.
