# rig — the design-56 test bench (P0)

Two ephemeral Linux devices, a throwaway account, real onboarding + convergence
against the **dev** worker — so a change can be validated before it ships, on data
that looks like a working machine, without risking one. This is the stability net
that the 2026-07-01 mass-delete and the 2026-07-02 conflict storm were found *by
bleeding on*. Full design: [`docs/design/56-test-bench.md`](../../docs/design/56-test-bench.md).

**P0 delivers:** `doctor` / `up` / `run onboard-smoke` / `down`, the device image,
`source` CLI mode, and the `onboard-smoke` PR gate. Prod is refused before any
container starts; every resource the rig creates is namespaced `rig-*`.

## Requirements

- macOS 26+ on Apple silicon (arm64) — container-to-container networking needs it.
- [Apple `container`](https://github.com/apple/container) v1.0.0 (`brew install container`).
- `bun` on the host.
- A dev bootstrap secret: env `RBOX_DEV_BOOTSTRAP`, or a line
  `RBOX_DEV_BOOTSTRAP_SECRET=<secret>` in `dev-keys.local.secret` at the repo root
  (gitignored; in a worktree the rig also probes the primary checkout). Never printed.

Run `bun run rig doctor` first — it checks all of the above and prints fix-it
commands. It never mutates anything.

## Usage

```bash
bun run rig doctor              # host preflight (read-only; exit 1 if anything is ✗)
bun run rig up                  # build the device image + start rig-dev-a / rig-dev-b
bun run rig run onboard-smoke   # the PR gate: bootstrap → init → pair → join → push/pull → assert
bun run rig down                # stop+delete containers + network
bun run rig down --all          # also delete the rig-device image + rig-* volumes
```

Flags: `--api-url <url>` (overrides `RBOX_API`; prod is always refused),
`--keep-account` (skip the per-run `DELETE /v1/account` teardown), `--all` (see above).

### What `onboard-smoke` does

1. **A** `rbox login --bootstrap` (secret injected by env, never argv).
2. **A** seed a ~100-file deterministic corpus (`scripts/bench/corpus.ts`, shape
   `tiny`) + a symlink (historic regression shapes: empty, duplicate, symlink).
3. **A** `rbox init --new`; read the workspace id from `.rbox/workspace.json`.
4. **A** `rbox push` (`RBOX_UPLOAD_CONCURRENCY=16` — the design-34 WAF rail).
5. **A** `rbox pair` → parse the token.
6. **B** redeem the token headlessly (`RBOX_PAIR_TOKEN`, via env).
7. **B** `rbox init --workspace <id>` + `rbox pull` (`RBOX_DOWNLOAD_CONCURRENCY=16`).
8. **Assert** A and B trees are byte-identical (excluding `.rbox/`), file count > 90,
   and the empty file + symlink survived.
9. **Teardown** host-side `DELETE /v1/account` with A's own owner creds (a live
   exercise of the design-37 deletion cascade). Skipped with `--keep-account`.
10. Write `report.json` + a PASS/FAIL table into the run dir.

## Run artifacts

Each run writes `scripts/rig/runs/<yyyymmdd-hhmmss>-<scenario>/` (gitignored):

- `run.log` — every step + assertion, timestamped.
- `report.json` — steps (with durations), assertions (pass/fail), scenario verdict.

Exit code: `0` PASS, `1` FAIL, `2` usage/unknown scenario.

## Architecture (P0)

- `rig.ts` — entry; hand-rolled arg parse; `doctor` / `up` / `run` / `down`.
- `lib/config.ts` — names/paths, `assertNotProd` (the prod rail), URL + image-hash resolvers. **Pure.**
- `lib/container.ts` — the **only** module that spawns `container` (+ host probes for `doctor`).
- `lib/device.ts` — a `Device` handle: `rbox` / `exec` / `readFile` / `writeFile` / `seedCorpus`.
- `lib/convergence.ts` — in-guest `find`+`sha256sum` tree fingerprint; A-vs-B compare (excl `.rbox/`). Pure builders/parsers.
- `lib/account.ts` — bootstrap-secret resolution (redacted) + host-side account teardown.
- `scenarios/` — `types.ts` (contract + report shaping), `index.ts` (registry), `onboard-smoke.ts`.
- `Dockerfile` — ubuntu:24.04 + pinned bun + baked linux-arm64 `node_modules`; `src/`+`scripts/` bind-mount at runtime.

Tests (`bun test ./scripts/rig/`) cover only the pure logic: the prod refusal, the
image-staleness hash, secret-resolution precedence + redaction, the fingerprint
parse/compare, the pair-token parse, and report shaping.

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

### CI — `.github/workflows/e2e.yml`

Manual (`workflow_dispatch`, input `scenario`, default `all`) + nightly
(`schedule`, ~02:00 San Diego). Targets a **self-hosted** `[macOS, ARM64]` runner —
**none is registered yet**, so the job queues/skips until the founder registers one
on the M2 Max (GitHub-hosted runners can't do macOS 26 + vmnet — design 56 §11). Set
the `RBOX_DEV_BOOTSTRAP` repo secret (and optionally `CLOUDFLARE_ACCOUNT_ID` /
`CLOUDFLARE_API_TOKEN` for the AE channel) before the runner goes live.

## What's next

The bootstrap `plan` param (unlocks the `development` tier), `binary` provisioning
mode, and perf budgets flipped from report-only to gating once burn-in data exists.
See design 56 §13 for the phase breakdown.
