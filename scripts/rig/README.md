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

## What's next (P1+)

Observability capture (log/metrics copy-out, `container stats`, `wrangler tail`, AE
SQL, `report.md`, `rig watch`), then the scenario suite (`two-device-live`,
`conductor-initial-sync`, `git-entanglement`, `type-flip`, `daemon-idle-cpu`,
`mass-delete-guard`), `binary` provisioning mode, the bootstrap `plan` param, and
CI. See design 56 §13 for the phase breakdown.
