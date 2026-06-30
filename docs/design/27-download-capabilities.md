# §27 — Short-lived download capabilities (P1)

> Status: **design (P1 — after §23)**. Decomposes into chunks when scheduled.
> The pull-side analogue of §23: stop doing a D1 entitlement read per blob GET.

## Problem
`blobGet` (`apps/api/src/blobs.ts:75`) checks entitlement in D1 **before every** blob GET
(the M7 "unentitled → 404, no existence oracle" guarantee). A fresh clone of N blobs = N D1
entitlement reads on the pull path — the download-side mirror of the upload D1 storm §23 fixes.

## Target
After the client verifies `latest()`/the commit (it already fetches + verifies the signed
commit + sidecar), the server issues **short-lived capability tokens** scoped to the exact
commit + sidecar root. Each subsequent blob GET is authorized by the **capability** (HMAC
verify + sidecar membership, no per-blob D1) instead of a per-blob D1 entitlement read.

Uncommitted uploads/sidecars are not pull-visible. Download capability issuance starts only
from committed metadata the caller is already authorized to read.

## Decision

### Authorization boundary
Capability issuance is the only D1 authorization boundary:
- `latest()` or `GET /v1/caps?commit=...` authenticates the caller and confirms the §07
  workspace membership / role / entitlement to that committed metadata (one check, not
  per-blob). Unauthorized workspace or commit access returns §07's indistinguishable 404
  before any sidecar or R2 lookup.
- The server fetches and validates the sidecar using §24.3 semantics: the sidecar object
  must exist, `sha256(bytes) == sidecarSha`, and parse invariants must hold.
- Missing, corrupt, or unparseable sidecar at issuance fails closed: issue no capability,
  alert, and return a generic `503 cap_unavailable` to the already-authorized client. Never
  mint a partial cap.
- Reuse the §23.1 receipt/HMAC primitive: a **download capability** is HMAC-signed over
  `{v, accountId, workspaceId, commitSha, sidecarSha, exp}`. The canonical scope is the
  `commitSha` + `sidecarSha` pair.

A download cap is not an account-wide grant. Do **not** use `account+epoch` as the default
boundary, and do not treat a content hash as authorization; hashes provide integrity and
equality, while authorization is the issuance decision tied to committed metadata.

### Scope and membership
- `blobGet?cap=...` verifies the HMAC and `exp`, then resolves `sidecarSha` to the parsed
  immutable sidecar set. The cache key is `sidecarSha`, populated only after the §24 hash
  and parse checks pass.
- Membership truth for `blobGet` is exactly: `requestedSha in parsedSidecar.encShaSet`.
  This check happens before any R2 read and replaces the per-blob D1 entitlement read on
  the cap path.
- There is no separate signed inclusion proof in v1. Add one only as future work if
  sidecar parse/cache cost becomes a measured problem.
- Batch roots may exist only as an internal packing optimization. A batch root must be a
  deterministic content-addressed set of exact `{commitSha, sidecarSha}` roots; the server
  expands it to those roots, and membership still bottoms out in parsed sidecar sets. It
  must never mean "all blobs for account X" or "all blobs during epoch Y."

### Revocation, expiry, and missing blobs
Choose fast age-out, not immediate revocation on `blobGet`, so the hot pull path stays
D1-free:
- Maximum capability TTL: 60 seconds. Device/account revocation or epoch bump is enforced
  at issuance, so revoked principals cannot receive new caps. Caps already issued before
  revocation remain usable until `exp`.
- Residual risk: a just-revoked principal can finish downloading blobs in an already-issued
  commit/sidecar-root cap for at most the TTL. It still cannot learn blobs outside that
  sidecar root because membership is checked before R2. If policy later requires instant
  kill, add a revocation-epoch cache/denylist as a separate design and account for that new
  hot-path lookup.
- `blobGet` returns the same 404 status/body for invalid HMAC, expired caps, membership
  misses, missing R2 blobs, GC-condemned blobs, and unauthorized requests. Missing or
  condemned in-scope blobs are not retried through global existence or entitlement checks;
  the client refreshes metadata/caps and re-pulls.

## No-oracle proof sketch
1. Without a valid cap, the existing §07 blob path remains: entitlement is checked before
   R2 and unentitled callers get indistinguishable 404.
2. With a valid cap, the only authorized blob universe is the parsed sidecar set committed
   by the signed commit body (§24.1/§24.3). A guessed sha outside that set fails membership
   before R2, so it cannot reveal whether the platform stores that blob.
3. A guessed sha inside that set is already in committed metadata the cap holder was
   authorized to read. If the object is missing or GC-condemned, the response is still the
   same 404, so physical storage state is not exposed as a separate oracle.

## Chunks / tests (when scheduled)
- **27.1 capability format + scope model:** HMAC fields above, `commitSha` + `sidecarSha`
  canonical scope, explicit rejection of account-wide / epoch-wide caps, optional internal
  batch-root packing only for exact sidecar roots.
- **27.2 issue endpoint:** one §07 authorization check; fetch/verify/parse sidecar per
  §24.3; missing/corrupt sidecar issues no cap and alerts.
- **27.3 `blobGet` cap path:** HMAC/expiry check, sidecar parse-cache lookup, `sha in
  parsed sidecar set` before R2, no per-blob D1.
- **27.4 security tests:** non-member sha with valid cap returns the same 404 and performs
  no R2 read; missing R2 object and GC-condemned object return indistinguishable 404;
  expired cap returns indistinguishable 404; revoked device cannot mint new caps and any
  old cap ages out within TTL; missing/corrupt sidecar at issuance mints no cap; batch-root
  cap rejects blobs not present in one of its exact parsed sidecar roots.

**Security-review heavy**: the load-bearing properties are the single issuance boundary,
parsed-sidecar membership truth, short TTL revocation semantics, and 404-before-R2
no-existence-oracle behavior.

---

## Benchmarking this change (against **dev**, not prod)

Validate on the **dev** worker `rbox-dev-api` — real Cloudflare D1/R2/DO, the only place
the latency/contention this change targets actually shows up (local Miniflare has ~0
network latency and would hide it). The dev deploy is a **separate, manual** step —
**do NOT push to `main` to test**: push-to-`main` auto-deploys *prod* (`deploy-api.yml`).

```bash
# on a branch/worktree with the change (server + the client binary if it's a protocol change):
cd apps/api && bunx wrangler deploy                  # → rbox-dev-api (dev only; prod untouched)
bun build --compile --target=bun-darwin-arm64 \      # match your platform; only if the client changed
  ./src/cli/index.ts --outfile /tmp/rbox
bun scripts/bench/push-sweep.ts --bin /tmp/rbox \
  --remote https://rbox-dev-api.brian-via.workers.dev --conc 8,16,32,64
```

- **Compare base vs head back-to-back** (deploy baseline → sweep → deploy change → sweep) so
  dev's shared-instance noise cancels — relative deltas are valid even though absolute dev
  numbers wander vs prod.
- **Drive the path this change affects:** push via `push-sweep.ts`; pull/clone-side changes
  by timing a fresh `rbox init --workspace <id>` into an empty dir (a clone-sweep is a TODO).
- **Success metric = this doc's Target/Goal section.** Once the §25 server metrics are live on
  dev you can read the server-side split (`d1Calls` / `d1Ms` / `r2Ms` per op) directly instead
  of inferring it from client wall-time — land §25 on dev first.
- Only merge to `main` (→ prod) once it's proven on dev.
- For an **isolated, repeatable** target (no contention with other dev work, wipe-and-repeat),
  set up a dedicated `[env.bench]` → `rbox-bench-api` + throwaway `rbox-bench-db`/`-blobs` and
  point `--remote` at it. (See the README "Benchmarking" section.)

---

## DEFERRED — measured low-ROI (2026-06-30)

Codex review (NEEDS-WORK) + a measurement gate (same discipline §26 specifies):
- **The pull D1 cost is small.** `blobGet`'s entitlement check is a single INDEXED `blob_refs`
  lookup (PK on (account_id, sha256)) — ~20 ms, not the 7-call ~956 ms storm §23 fixed on the
  upload side. A real clone of 2000 savvy-core blobs = **15.1 s wall**, of which the per-blob D1
  is ~1.25 s (≈**8%**); the rest is R2 transfer + client decrypt/write. §27 would save ~8% at best.
- **Inline membership is NOT D1-free (codex BLOCKER).** Workers have no shared cross-invocation
  cache, so checking `sha ∈ commit.blobRefs` per GET means re-fetching+parsing the (up to 1 MB)
  commit body from the DO each time — *worse* than today's indexed read. A genuinely D1-free cap
  path needs **Merkle inclusion proofs** (cap binds a ref-set root; client sends a per-blob proof;
  server verifies HMAC(root)+path, no fetch) — substantial client+server complexity.
- Codex's other findings (membership must include `encManifestSha`; bind
  {account,workspace,project,sequence,commitSha,iat,exp} + recompute sha256(body)==commitSha at
  issuance; cap in a HEADER not the query string; pre-auth cap path with NO legacy fallback;
  GC-condemned handling) are all correct and would need addressing.

**Decision: defer §27.** An ~8% pull win behind Merkle proofs + §24 is not worth it now. Revisit
if/when (a) §24 (sidecar) lands (clean cacheable membership) AND (b) a measurement shows pull is
D1-bound at scale. The codex review above is preserved for that future implementation.

---

## CONFIRMED DEFERRED — direct measurement (2026-06-30)

The earlier deferral (above) was by inference; it's now confirmed by a direct **download-concurrency
sweep** on a savvy-core clone (4287 blobs, dev), which is the cheap lever §27's capability scheme
would compete with:

| download concurrency | clone wall (2 sweeps) |
|---|---|
| 32 (old default) | 28.8s / 31.6s |
| 64 (new default) | 26.4s / 27.2s |
| 96 | 25.6s / 26.9s |
| 128 | 22.9s / 23.7s |

The clone time **falls monotonically as concurrency rises, with NO hard plateau** — which means the
per-blob entitlement D1 read (the thing §27 removes) is **not** the clone bottleneck; download
THROUGHPUT is. §27 would remove a read that isn't contended, behind real Merkle-inclusion-proof
complexity, for ~8%. The actual pull win was a stale default: download concurrency was 32
"by analogy with the old upload knee" — bumping it to 64 (`src/engine/apply.ts`) ships ~14% for one
line, env-tunable toward 128. §27 stays deferred until a measurement shows pull is genuinely
D1-bound at scale (and even then, §24's sidecar now gives a cacheable-membership path that may beat
per-blob capabilities). **Third confirmation that the simple lever beats the complex feature.**
