# §131 — Rig container-runtime backends (Apple `container` on macOS + Docker on Linux)

> **Status: 🚧 DESIGN v3 — 2026-07-16 (rounds 1-2 applied).**
> Today the rig (design 56) runs ONLY on the Mac via Apple `container`, so every field
> validation round-trips SSH to another machine. Design 56 §"supersedes" deliberately
> deferred portability ("commits to Apple `container` concretely"); this design pays that
> deferred cost now that the rig has proven its value (it caught the zombie-lock class the
> day it was repaired). Target: `rig up && rig run all` works natively on this Linux host
> (Docker 24 present at /usr/local/bin/docker) with identical scenario semantics.

## Recon facts (2026-07-16, verified)

- **Single choke point**: every runtime invocation goes through `scripts/rig/lib/container.ts`
  (`run()` prepends `"container"`; module header documents this). No other file spawns
  container processes. No `container cp` anywhere — all host↔guest movement is bind mounts
  or `exec` with piped stdio (already portable).
- The rig's `--mount` grammar is NEAR-Docker (round-1 F1 correction: `type=` is optional in
  `mountArg` and BOTH real call sites omit it; Docker requires it) — each backend's mount
  serializer injects its defaults (`type=bind` on Docker), with golden argv tests for both
  creation paths. `build -t/-f/--build-arg/--label <ctx>`, `create --name/--network/
  --cpus/--memory/-e`, `start`, `stop`, `exec -i/-e/-w`, `kill --signal`, `logs --follow`,
  `network create`, `volume rm` are verbatim-compatible. Only lexical verb drift elsewhere:
  `image delete`→`image rm`, `network list/delete`→`ls/rm`, `ls --all`→`ps -a`,
  `delete --force`→`rm --force`, `volume list`→`volume ls`.
- Genuinely divergent: (a) `container system status/start` has NO Docker analog;
  (b) `inspect` mount shape (Apple nested `configuration.mounts` vs Docker flat top-level
  `Mounts[].Source/Destination`); (c) `stats` JSON (Apple numeric cumulative usec vs Docker
  pre-formatted percent STRINGS — different parser AND different math); (d) Docker HONORS
  the image ENTRYPOINT that Apple ignores (the explicit tini `cmd` override exists for
  Apple; on Docker it is redundant); (e) `doctor()` checks are macOS/Homebrew-specific.
- Prod-refusal (`assertNotProd`) is pure URL logic — untouched, both backends.

## Design

### Backend seam — keep today's function signatures, dispatch inside

`lib/container.ts`'s exported functions stay the seam (every consumer — rig.ts, device.ts,
capture.ts — keeps its imports). Internally the module resolves a `RunnerBackend` once:

```ts
interface RunnerBackend {
  bin: string;                                  // "container" | "docker"
  name: "apple-container" | "docker";
  verbs: { imageDelete: string[]; networkList: string[]; networkDelete: string[];
           psAll: string[]; containerDelete: string[]; volumeList: string[]; ... };
  ensureRuntimeReady(): Promise<void>;          // apple: system status→start; docker: `docker info`
  parseInspectMounts(json: unknown): Array<{source: string; target: string;
    type?: string; readonly?: boolean}>;        // per-backend shape; the reuse guard keeps
                                                // fail-closed source+TARGET matching (r1-F6)
  parseStats(json: string): StatsSample[];      // → CANONICAL contract (r1-F2; r2: field stays ts,
                                                // assessIdle filters on ts today): {name, ts,
                                                // memBytes, cpu: {kind:"cumulative-usec",usec}
                                                // | {kind:"instant-percent",pct}}, runner tag
                                                // persisted WITH the samples; the budgets
                                                // reducer integrates instant-percent across
                                                // intervals (Docker) and keeps delta math for
                                                // cumulative-usec (Apple) — idle-cpu mean/peak
                                                // tested end-to-end on BOTH sample kinds
                                                // idle peak gates on instant-percent p95 (raw max
                                                // remains context), cumulative-usec true max
                                                // (field calibration, first Docker run)
  createCmdOverride(): string[] | undefined;    // apple: ["/usr/bin/tini","--","sleep","infinity"];
                                                // docker: undefined (ENTRYPOINT honored — the image's
                                                // tini ENTRYPOINT + sleep CMD apply; zombie reaping
                                                // rationale stays true, delivery mechanism differs)
  parseSpecLabel(inspectJson: unknown): string | undefined; // typed per-backend label read
                                                // (divergent inspect shapes); mismatch AND
                                                // malformed-label -> recreate, unit-tested (r2)
  doctorChecks(): DoctorCheck[];                // per-platform sets (below)
}
```

Selection: `--runner container|docker` flag > `RBOX_RIG_RUNNER` env > platform default
(darwin→apple-container, linux→docker). The resolved backend name is REQUIRED in `report.json`
(`runner: string`), `report.md`, and the persisted stats files (r1-F2 — Apple semantics
leak into report.md/stats-*.jsonl today, not report.json). Backend runs are never
cross-compared (per-VM vs shared-kernel physics). Existence checks are REWRITTEN per
backend (r1-F3 — the substring approach CAN false-positive: `rig-device-old` satisfies a
`rig-device` includes(); values in Command/labels can match names): Docker output is
parsed as NDJSON line-by-line with typed exact-field comparison; image existence uses
`docker image inspect <tag>`; containers/networks/volumes use exact-name filters. Apple
keeps its documented substring defense (its JSON shape is unstable). `rigVolumes` returning
[] on parse failure is replaced with fail-loud (silent [] leaks volumes through
`down --all`). `rig watch` routes through a new backend-aware `streamContainerLogs()`
(r1-F5 — it hard-codes `container logs --follow` today, bypassing any dispatch).

### Docker-branch specifics

- `ensureRuntimeReady`: `docker info` (bounded timeout) AND remote-context refusal lives
  HERE (r2: doctor is advisory; up/run call ensureRuntimeReady directly — a remote Docker
  context whose daemon cannot see this checkout's bind paths must refuse at the
  runtime-ready gate). Failure prints a Linux fix-it (daemon down / socket perms — not brew).
- `inspect` mounts: parse flat `Mounts[].Source`; same recreate-on-foreign-worktree logic.
- `stats`: parse Docker's `--no-stream --format json` NDJSON (`MemUsage` "1.5GiB / 31GiB",
  `CPUPerc` "12.34%") into the existing `CaptureSummary` fields; values labeled by backend;
  no cumulative-usec math on Docker (its CPU% is precomputed — record it as-is with a
  `runner` tag; the report renderer prints units per backend honestly).
- `create`: no cmd override (ENTRYPOINT honored). The Apple-specific comment at the two
  call sites moves into the backend (`createCmdOverride`), so neither call site carries a
  wrong-for-Docker rationale.
- `doctor` (linux, r1-F7/F8 — daemon-info-based, not host heuristics): `docker info`
  fields (server version/OS, cgroup driver+version, `MemoryLimit`, CPU-quota capability,
  `DockerRootDir`), local-vs-remote context check (bind paths resolve on the DAEMON host —
  refuse remote contexts), disk space across DockerRootDir + runs dir + workload cache,
  and a transient namespaced probe (create a throwaway container with a read-only bind of
  the checkout, read a file, hit the network, delete) — an actual probe catches
  SELinux/AppArmor bind denials without penalizing their mere presence. Rootless (r2 — ONE deterministic
  policy): delegated controllers + enforceable limits -> proceed normally; otherwise
  resource-budget scenarios are SKIPPED with a `rootless-unvalidated` marker in
  report.json/report.md — never a plain warn, never a whole-rig hard fail. (Bind writes
  and resetGuests are unaffected by rootless — all host binds are read-only and resets act
  inside the container namespace.)
- Image/Dockerfile: UNCHANGED (ubuntu:24.04 + git PPA + pinned bun + tini). One image tag serves both
  backends. Recreation enforcement is by CONTAINER LABEL, not hash-file (r1-F4: the hash
  only gates image REBUILD; containers were reused whenever mounts matched, so create-spec
  drift could reuse stale containers): every created container carries a
  `rig.spec=<hash(runner + image hash + normalized create args)>` label; `ensureUp`
  recreates on label mismatch. The `.image-hash` cache file becomes per-runner records so
  backend switching doesn't force rebuilds. Recreation tested via same-runtime create-arg drift with pre-existing containers
  (r2: cross-runtime switching is namespace-separate and proves nothing).

### Explicitly unchanged

Scenario code, `Device`, `resetGuests`, run-artifact layout, prod-refusal, network naming
(`rig-net` — `docker network create` is drop-in), sequential FAST_SUITE execution, the
mount-source worktree-identity recreation logic, and the `rig down` before `up` rule becomes UNNECESSARY for
create-arg changes (the spec label recreates automatically); runner switches need nothing —
each runtime's containers live in its own namespace.

### Disk hygiene (founder addendum, 2026-07-16 — this host was once filled to 760 GB by
### GH-runner containers leaking ~13 GB/day; the rig must be leak-proof by construction)

- **Everything the rig creates carries a `rig=1` label** (containers, image builds, network,
  volumes) — one namespace for scoped cleanup. **Global prunes (`docker system prune`,
  unscoped `builder prune`) are FORBIDDEN** — this is a shared machine running other Docker
  workloads.
- `ensureImage`: after a successful rebuild to a new hash, the superseded rig image is
  deleted (today only `down --all` deletes it — rebuild generations would otherwise
  accumulate as dangling layers forever).
- `rig down --all` additionally prunes dangling rig-labeled images.
- New **`rig gc`** subcommand: reports and reclaims — dangling rig-labeled images/volumes,
  `runs/` directories beyond the newest 30 (also auto-trimmed at `rig up`), workload-cache
  entries LRU beyond a size cap — printing reclaimed sizes.
- Doctor gains a **disk-headroom hard gate**: < 20 GB free in `DockerRootDir` (or the runs
  dir / workload cache filesystems) → FAIL with a fix-it naming `rig gc` and, for build
  cache the rig cannot safely scope, the manual `docker builder prune` the operator can
  choose to run. Doctor also REPORTS builder-cache size so growth is visible before it
  hurts.
- Acceptance additions: after the full FAST_SUITE + `down --all`, `docker images` shows no
  rig-labeled dangling images and `docker system df` deltas for volumes/containers
  attributable to the rig are zero; `rig gc` on a dirtied state reclaims and reports.

## Tests

- Unit (no daemon needed): verb-mapping table per backend (argv golden per call); inspect
  mount-shape parsers (fixture JSON both shapes); stats parsers (fixture NDJSON/JSON both
  shapes, backend labeling); backend selection precedence (flag > env > platform);
  image-hash includes runner; `createCmdOverride` per backend; doctor check sets
  per platform (pure, with injected probes).
- Config tests untouched (prod-refusal already unit-tested, backend-agnostic).
- **Acceptance (r1-F9 — the full gate, not a smoke)**: the COMPLETE `FAST_SUITE` (all six
  scenarios incl. stats-dependent `daemon-idle-cpu` and the reset-reuse-heavy git
  scenarios) green with `--runner docker` on THIS host against rbox-dev-api, reports
  carrying `runner: "docker"`; `rig watch` streams via the backend; a deliberately
  created `rig-*` volume is removed by `down --all`; spec-label drift WITHIN a runtime (changed create args while containers exist) recreates
  via the label guard (r2 correction: runner switching proves nothing — each runtime holds
  a SEPARATE container namespace, so returning to A legitimately reuses A's
  still-matching containers); teardown leaves `docker ps -a` / `volume ls` /
  `network ls` free of `rig-*`. (Two-scenario runs remain the quick developer smoke.)

## Non-goals

- podman support. (Rootless-docker: the deterministic skip-with-marker policy above.)
- Cross-backend performance comparison (reports label the backend; comparing is on the
  reader, and the docs already forbid it).
- `chaos-restart` suite inclusion (its exclusion was an Apple-wedge posture; revisit
  separately on Docker where kill/start is reliable — a future note, not v1).
- Changing scenario semantics, image contents, or the Mac flow (Apple backend behavior is
  byte-identical to today).
