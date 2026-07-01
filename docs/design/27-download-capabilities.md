# §27 — Signed download grants (take D1 off the blob-GET hot path) (P1)

> Status: **design (codex round-1 NEEDS-WORK — 2 open founder decisions block implementation; v4)**.
> See **OPEN QUESTIONS (founder decision required)** below before writing any code. Basis:
> [`22-server-throughput.md`](22-server-throughput.md); write-side analogue:
> [`23-upload-receipts.md`](23-upload-receipts.md).
> The pull-side mirror of §23: §23 made `PUT` D1-free with an HMAC upload **receipt**;
> §27 makes `GET` D1-free with an HMAC download **grant**.

## Why this is un-deferred (new data supersedes the 2026-06-30 deferral)

This doc was deferred **twice** on 2026-06-30 on a measured "~8% pull win" basis (see the
preserved appendix). Both deferrals were made **by inference / client wall-time**, before
§25 server-side metrics existed, and both assumed the entitlement read was a cheap ~20 ms
indexed lookup. **Analytics Engine (§25) now measures the real thing on the live path:**

| `blob.get` p50 | of which D1 | of which R2 | D1 calls / GET |
|---|---|---|---|
| **228 ms** | **185 ms (81%)** | 40 ms | **1** |

The ~20 ms figure was the *uncontended* cost. Under a **64-wide concurrent pull** the single
per-GET `isEntitled` read (`SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?`) serializes
against a **single-threaded D1** and balloons to **185 ms — 81% of GET latency**. This is the
exact read-side twin of the upload D1 storm §23 already fixed. Removing it targets
**GET p50 ≈ 228 ms → ≈ R2-only ≈ 40 ms** (~5× on the hot path).

The old deferral's headline BLOCKER — "inline membership is not D1-free without Merkle proofs" —
**does not apply to this design**, because this design does **not** do per-blob membership at GET
(see *Scope*). It reproduces exactly today's authorization boundary, which is already
account-scoped, with an HMAC signature instead of a D1 row read.

---

## OPEN QUESTIONS (founder decision required — implementation is BLOCKED on these)

Codex round-1 verified the core technical claims (isEntitled is account-scoped, `blobKey` is
global, `encSha` is ciphertext under a secret per-workspace KEK, GET writes no quota) but raised
two findings it classified as **product/architecture decisions**, not mechanical fixes. Both are
escalated here; **do not implement until they are answered.**

**Q1 (BLOCKER) — Is the production R2 bucket provably ciphertext-only?** The grant's cross-account
safety rests on "an account can only *name* its own `encSha`s" (Security §3). That holds because the
official client is fail-closed E2EE (`sync.ts:336-343` throws without a KEK; uploads only by
`encSha`; `buildAuthedRemote` refuses pre-E2EE workspaces) — **but the server is
content-agnostic**: `blobGet`/`blobPut` cannot distinguish an `encSha` from a plaintext `sha256`
(both are `/^[0-9a-f]{64}$/`, `blobKey` is global), and there is **no server-side E2EE/roster gate
on PUT**. So the invariant is *client-enforced only*. If any **legacy plaintext blob** (pre-E2EE
M5 era) still lingers in the shared prod bucket keyed by a *globally-guessable* plaintext sha, a
valid account grant would turn that guessable key into a cross-account read (skipping the `isEntitled`
gate that blocks it today). Design 12 §9/§13.9 **mandated a pre-launch prod D1+R2 wipe** precisely
because E2EE was greenfield (no plaintext→ciphertext migration). **Founder must confirm that wipe
was executed** (bucket contains only E2EE ciphertext). Options if it cannot be confirmed: (a) run
the wipe now (greenfield, no real users per design 12); (b) put grant-eligible E2EE blobs under a
**separate R2 prefix** so a grant can never authorize a legacy-prefix key; (c) keep §27 deferred.

**Q2 (MAJOR) — Accept `encSha` as a bearer capability for ciphertext + existence?** The grant path
intentionally converts "any `encSha` the caller can name" into "200 if present / 404 if absent,
served without a D1 entitlement check." For the caller's *own* account this is exactly today's
reachable set; the residual is: a *leaked or shared* `encSha` (out-of-band) becomes a
ciphertext-read + existence capability for whoever holds a valid grant for the owning account —
whereas today `isEntitled` still 404s a known-but-unentitled sha. The bytes are always E2EE
ciphertext (no plaintext ever), so this is a **confidentiality-of-*existence* + ciphertext-blob**
trade, deliberately swapping the per-GET accounting check for E2EE-backed unguessability. The task
framing ("a leaked grant → opaque bytes; the entitlement check is quota/access-accounting, not
confidentiality") reads as founder acceptance of exactly this posture — **please confirm explicitly**,
since it is the load-bearing security assumption of the whole design.

> If Q1 is confirmed (or resolved via a separate prefix) and Q2 is accepted, the rest of this doc is
> implementation-ready and the remaining codex findings (below) are already resolved mechanically.

---

## Problem (one paragraph)

`blobGet` (`apps/api/src/blobs.ts:167`) calls `isEntitled(env, accountId, sha)`
(`apps/api/src/authz.ts:46`) — one D1 point read — **before every** blob GET, to enforce the M7
"unentitled → indistinguishable 404, no existence oracle" guarantee. A fresh clone of *N* blobs
is *N* serialized D1 entitlement reads on the single-threaded D1, on the pull hot path. That read
is the download-side mirror of the upload D1 storm §23 removed with receipts.

## Ground truth from the code (verified, not assumed)

These facts are load-bearing for the security analysis; each was read directly:

1. **Entitlement is already ACCOUNT-scoped, not workspace-scoped.** `isEntitled` is
   `SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?` — **no workspace column.**
   `blobGet(env, sha, accountId)` never receives a `workspaceId`. Any device in an account can
   already GET any blob the account is entitled to, regardless of which workspace it belongs to.
   The per-workspace boundary is enforced *upstream* (at `authorizeWorkspace` on `latest()` and by
   the E2EE manifest/roster), **not** at `blobGet`.
2. **R2 is a global content-addressed store.** `blobKey(sha) = blobs/sha256/<aa>/<sha>`
   (`util.ts:20`) — **no account prefix.** Blobs dedup across accounts; the *only* cross-account
   read barrier at GET is `isEntitled`.
3. **Blob content addresses are unguessable across accounts (E2EE).** Blobs are fetched by
   `encSha` on the production path (`apply.ts:138-142`). `encSha = sha256(AES-256-GCM ciphertext)`,
   where the DEK+nonce derive via a single HKDF from the **per-workspace, per-epoch secret KEK**
   and the plaintext sha (`crypto.ts:10-17,44-45`). A fresh epoch ⇒ fresh KEK ⇒ a convergent
   `(key,nonce)` pair never recurs. Consequence: `encSha` is a hash of ciphertext produced under a
   **secret** key, so **another account cannot name it** without the KEK — and even if it did, the
   bytes are ciphertext it cannot decrypt.
4. **GET touches no quota / billing / usage.** `blobGet` has zero calls to `wouldExceedCap`,
   `grantEntitlementWithQuota`, `used_bytes`, or any meter. Quota is charged at **commit**
   (§23.4), never on GET. Removing the per-GET D1 read has **no accounting side-effect** to
   preserve — only the *authorization* semantics (unentitled → indistinguishable 404) and the
   no-oracle ordering (auth decision **before** R2).
5. **`latest()` already does the per-pull authorization.** `GET /v1/ws/:ws/proj/:proj/latest`
   runs `authorizeWorkspace` (cross-account → indistinguishable 404) in `worker.ts` before
   forwarding to the `WorkspaceSync` DO. This is the one place, once per pull, where the caller is
   already proven authorized to the workspace's committed metadata. **This is where the grant is
   minted** — it piggybacks on an authorization that already happens, adding zero new D1 reads.

---

## The scheme

### Mint (server, at `latest()`)

When `GET /v1/ws/:ws/proj/:proj/latest` succeeds (caller authorized to the workspace), the server
mints a **download grant** — an HMAC-SHA256 token, cloning the §23.1 receipt primitive exactly
(`receipts.ts`): domain-tagged, key-fingerprint `kid` for rotation, fail-closed key loader, cached
`CryptoKey` + `kid` maps, `ctEqual` compare — and returns it as a new field on the `latest`
JSON response body:

```jsonc
// GET /v1/ws/:ws/proj/:proj/latest  →
{ "sequence": 42, "commit": { /* SignedCommit, unchanged */ },
  "grant": "<kid>.<b64url(payload)>.<b64url(mac)>" }   // NEW, optional field
```

Signed payload (distinct `DOMAIN = "rbox.grant.v1|"` so a grant and a receipt are
cryptographically **non-interchangeable** even under a shared key):

```ts
interface GrantPayload {
  v: 1;
  a: string;   // accountId  — ENFORCED at GET
  w: string;   // workspaceId — issuance provenance / audit; NOT enforced at GET (see Scope)
  t: number;   // mint time (ms epoch)
  e: number;   // expiry = t + GRANT_TTL_MS
}
```

Mint is **best-effort / non-fatal**: if `RBOX_GRANT_KEY` is unset or minting throws, `latest()`
logs (metadata-safe) and returns the body **without** a `grant` field. Old clients never sent one;
new clients that receive no grant fall back to the existing D1 path. This removes any provisioning
flag-day: a missing/misconfigured key degrades to "no speedup," never "broken pull."

### Verify (server, at `blobGet`)

`GET /v1/blobs/:sha` gains one optional request header, `x-rbox-download-grant: <token>`:

```
if header present:
    r = verifyGrant(env, token, { accountId: p.accountId, nowMs: Date.now() })
    if r.ok:                      # valid HMAC + not expired + a == p.accountId
        → SKIP isEntitled (no D1); go straight to R2 get + existing 404-on-miss
    else:
        → fall through to the D1 path below   (forged/expired/mismatched grant is treated as "no grant")
# no valid grant → existing behavior, unchanged:
if not await isEntitled(env, p.accountId, sha): return notFound()   # the legacy D1 path
→ R2 get + existing 404-on-miss
```

`accountId` is bound from the **authenticated principal** (`p.accountId` from the device token),
**not** from the grant — the grant's `a` must *equal* the authenticated account. A grant is
therefore useless to any principal other than the account it was minted for; it is **not** a
bearer token that stands alone.

### Client

- `RboxApi` (`src/cli/remote.ts`) stashes the grant on a private field (next to the existing
  `receipts` map) when it parses the `latest()` / `latestCommit()` response, and clears it at end
  of run like `receipts`.
- `getBlobToFile` / `getBlob` attach `x-rbox-download-grant` when a grant is held. One `RboxApi`
  instance backs every GET in a run (via `E2eeRemote` → `RemoteBlobStore` → `applyActions`), so a
  single stashed grant covers the whole pull, **including the git-section GETs** in `sync.ts`.
- **Long-pull refresh:** if a GET returns `404` while a grant *was* presented and the grant is now
  within `GRANT_SKEW` of expiry (or the client's clock says it is expired), the client re-calls
  `latest()` once to obtain a fresh grant and retries the GET. This keeps `GRANT_TTL` short for
  revocation while covering clones that outlast one TTL. (A 404 is also the legitimate
  "blob genuinely gone" answer, so the refresh-and-retry is attempted **at most once per blob**;
  a second 404 is surfaced as today.)

### TTL

`GRANT_TTL_MS = 300_000` (5 min). Rationale: long enough to cover a typical clone without a
mid-pull refresh (a 4287-blob dev clone is ~23–28 s); short enough that the revocation residual
(below) is a few minutes, not the receipt's 12 h. Big-monorepo clones that exceed 5 min are
covered by the client refresh above. `CLOCK_SKEW_MS = 60_000` on `t`, matching receipts.

## Scope: account-scoped, and why that is the *correct* scope (not just simplest)

The grant is scoped to **`accountId` + `exp`** (the fields `blobGet` can verify with zero extra
context). `workspaceId` is signed for audit/provenance but **not enforced at GET**, because:

- **Content-addressed dedup has no per-blob workspace.** A blob (by `encSha`) can be referenced by
  many workspaces/commits in an account; `blob_refs` has no workspace column. There is no
  workspace→blob map to enforce at GET that would not itself be a D1 read — defeating the purpose.
- **Account scope reproduces today's boundary *exactly*.** `isEntitled` is already account-scoped
  (fact 1). The grant drops only the per-`sha` row existence check; it does **not** widen the
  principal's reachable set beyond what today's account-scoped check already allows, because the
  reachable set is bounded by *which shas the bearer can name*, and (fact 3) an account can only
  name its own `encSha`s.

**Blob-set-digest / sidecar scoping is explicitly REJECTED for v1.** Scoping a grant to a commit's
ref-set (as the original §27 draft did) requires proving `sha ∈ refset` at GET. With no
cross-invocation cache, that means either re-fetching+parsing the (up to ~2 MB) sidecar per GET
(**worse** than today's indexed read — the original §27 BLOCKER) or shipping **per-blob Merkle
inclusion proofs** (substantial client+server complexity). Content-addressing + E2EE already
dissolve the boundary that scoping would protect, so the complexity buys nothing. Recommend
account-scope; revisit only if a future requirement introduces a real intra-account blob
confidentiality boundary (there is none today).

## Security analysis

**Threat model delta.** The *only* behavior change is: for a request carrying a valid
account-`a` grant, the server serves `blobKey(sha)` from R2 **without** confirming a
`blob_refs(account_id=a, sha256=sha)` row exists. Everything else (auth of the principal, the
`a == p.accountId` bind, 404-before-nothing ordering, no quota) is unchanged.

1. **Forgery / tampering.** HMAC-SHA256 over a domain-tagged, `kid`-pinned body with a fail-closed
   ≥32-byte key and constant-time compare — identical to the shipped §23 receipt, which is the
   product's existing unforgeability primitive. A distinct `DOMAIN` makes a receipt unusable as a
   grant and vice-versa even under a shared key.
2. **Replay / theft.** A grant is bound to `accountId` and only honored when it equals the
   **authenticated** principal's account. A stolen grant is worthless without also stealing that
   account's device token — and a device-token holder can already pull. So the grant grants **no
   capability its bearer did not already have** via the device token + `latest()`.
3. **Cross-account read.** To read account B's bytes, account A must (i) present a grant with
   `a = B` — impossible, A can't mint B's grant, and a grant is only honored when `a ==` the
   *authenticated* principal's account (A can't authenticate as B without B's device token); **or**
   (ii) hold a valid `a = A` grant and *name* an `encSha` that is B's — infeasible without B's
   secret per-epoch KEK (fact 3), **provided the bucket is ciphertext-only (Q1)**. If a legacy
   plaintext blob of B's existed under a guessable key, (ii) would succeed — hence Q1 is a hard
   precondition, not an assumption. Even then, the bytes are E2EE ciphertext A cannot decrypt.
4. **Existence + ciphertext-read is a deliberate bearer capability on `encSha` (Q2), not "no
   oracle."** Honest statement: on the grant path, `blobGet` answers "200 if `blobKey(sha)` present,
   404 if absent, no D1 check" for **any** `encSha` the caller can name. For a caller's own account
   this equals today's reachable set; the delta vs today is that a *known-but-unentitled* `encSha`
   (e.g. one leaked/shared out-of-band) now returns 200-if-present instead of `isEntitled`'s 404.
   The response is still a uniform 404 for absent/forged/expired/unnamed cases, so a caller cannot
   probe presence for an `encSha` it cannot produce — and (fact 3 + Q1) it can only produce its own
   account's `encSha`s. This is the accepted trade (Q2): swap an accounting check for E2EE-backed
   unguessability. GC-condemned-but-still-present blobs behave as today (`blobGet` does not consult
   `gc_candidates`).
5. **What entitlement was actually protecting.** `blob_refs` is quota/access **accounting** (which
   blobs an account has legitimately obtained), not a confidentiality boundary — confidentiality is
   E2EE. The one concrete semantic change: a sha that is in R2 but **not** in the account's
   `blob_refs` (uploaded via receipt but never committed, or a ref later removed by untrack/GC)
   returns 404 today but *would* be served under a valid grant **within TTL** to a caller that can
   name it. In every such case the caller is the account that uploaded those very bytes (that is
   how it can name them) and the bytes are its own E2EE ciphertext — no confidentiality loss.

### Revocation & expiry

- Device/account revocation and epoch bumps are enforced **at issuance**: a revoked principal
  cannot obtain a *new* grant (it fails `authenticate`/`authorizeWorkspace` at `latest()`).
- **Residual (stated precisely — this is NOT merely a 5-minute window; codex round-1 MAJOR).**
  `GRANT_TTL` bounds a *single* grant, but a **still-authorized** principal re-mints grants freely
  via `latest()`, so for as long as it retains workspace authorization it can GET, D1-free, **any of
  its own account's `encSha`s that are still present in R2** — *including* two sets that today's
  `isEntitled` 404s: (a) blobs uploaded via a §23 receipt-PUT but **never committed** (no
  `blob_refs` row); (b) blobs whose `blob_refs` row was **removed** by untrack or by §33/gc-phase1
  (`gc-phase1.ts:94`) but whose R2 bytes are **not yet purged**. Under the grant path these are
  served until the R2 object is actually deleted (or the principal loses authorization). In every
  case these are the **account's own E2EE ciphertext** (that is *why* it can name them), so there is
  **no cross-account confidentiality impact** — but the doc must not claim a tidy 5-minute revocation
  bound. The `GRANT_TTL` only bounds a *stolen* grant used by a *non-authorized* holder (who also
  needs the account's device token to pass `a == p.accountId`, making theft alone insufficient).
- **Implication for future instant-revocation:** if policy ever needs a device revocation to
  *immediately* cut off in-flight downloads (rather than at next-mint), that requires a
  revocation-epoch denylist checked on `blobGet` — a separate design with its own re-introduced
  hot-path lookup; explicitly out of scope here.

### Dependency: E2EE is the cross-account barrier

Property 3 depends on the bucket being ciphertext-only. The official client is fail-closed E2EE
(`sync.ts:336-343`), so no *legitimate* upload is ever plaintext, and `buildAuthedRemote` refuses
pre-E2EE workspaces (`e2ee-client.ts:205`). But the **server does not enforce this** (it stores any
hash-consistent bytes under any 64-hex key), so the invariant is client-side. The remaining risk is
**legacy plaintext residue** in the shared prod bucket — see **Q1** (founder must confirm the
design-12-mandated pre-launch prod R2 wipe was executed, or adopt a separate E2EE-only R2 prefix).
The plaintext-sha GET path (`apply.ts:153`) is unreachable in a production E2EE workspace (every
prod manifest entry carries `encSha` and a `kek` is always injected).

## Backward compatibility (hard requirement — spelled out)

No coordinated flag-day, no breaking change, either direction:

| Client \ Server | old server (no mint) | new server (mints) |
|---|---|---|
| **old client** (no header) | today's D1 path | today's D1 path (no header ⇒ D1 path) |
| **new client** (sends header when held) | never receives a grant ⇒ never sends header ⇒ D1 path | receives grant ⇒ sends header ⇒ **D1-free**; if grant absent/expired ⇒ D1 path |

- A new client only sends `x-rbox-download-grant` **if** it received a `grant` from `latest()`.
  Against an old server (no `grant` field) it holds nothing and behaves exactly like an old client.
- The server **always** keeps the `isEntitled` D1 path and takes it whenever the header is absent
  **or** the grant is invalid/expired/mismatched. A forged or stale grant is never an error — it is
  simply "no valid grant," falling through to D1. Old clients are byte-for-byte unaffected.
- Mint is best-effort (above): even a new server with an unset `RBOX_GRANT_KEY` just omits the
  grant, and everyone is on the (correct, secure) D1 path.

## Quota / accounting

No change and nothing to preserve: GET charges no quota today (fact 4); quota is a commit-time
concern (§23.4). Removing the per-GET D1 read cannot affect `used_bytes` or any meter. Verified by
reading `blobGet` end-to-end — the only non-D1 side effect it has is telemetry (`startOp`/`op.done`
/`op.span.r2`), which is preserved (and gains a `grant`/`d1`-skipped dimension for §25).

## Files / impact

**Server (`apps/api/src`):**
- `grants.ts` — **new.** `mintGrant(env, {accountId, workspaceId, nowMs})` + `verifyGrant(env,
  token, {accountId, nowMs})`, self-contained clone of the `receipts.ts` primitive with
  `DOMAIN="rbox.grant.v1|"`, `GRANT_TTL_MS`, best-effort key loader (missing key ⇒ mint returns
  `undefined`; verify returns `{ok:false}`). Reuses `ctEqual` from `util.ts`. (Kept separate from
  `receipts.ts` to avoid touching shipped §23 code; a shared `hmac-token.ts` refactor is noted as
  future cleanup.)
- `env.ts` — add `RBOX_GRANT_KEY?: string` (+ `RBOX_GRANT_KEY_PREV?` for rotation), Wrangler
  secret, documented fail-closed-on-verify / best-effort-on-mint.
- `blobs.ts` — `blobGet` gains an optional `grant?: string` arg; if present and `verifyGrant` ok,
  skip `isEntitled`; else existing path. Add a §25 telemetry tag for the taken path.
- `worker.ts` — read `x-rbox-download-grant` and pass to `blobGet` (GET route ~line 312); mint a
  grant in the `latest` response assembly and include it in the JSON (best-effort).
- **Grant minting is worker-side, MANDATORY (codex round-1 MINOR — not optional).** The HMAC key
  (`RBOX_GRANT_KEY`) MUST NOT enter the `WorkspaceSync` DO. `worker.ts` mints the grant *after* the
  DO's `latest()` responds and splices the `grant` field into the parsed JSON body (it has `env` +
  the authenticated principal + `ws`/`proj` in scope). `workspace-sync.ts` is **not** modified to
  hold key material and does not see `RBOX_GRANT_KEY`.
- `vitest.config.ts` — add `RBOX_GRANT_KEY` test binding.

**Client (`src`):**
- `remote.ts` — private `downloadGrant?: string` on `RboxApi`; capture in `latest()` /
  `latestCommit()`; attach `x-rbox-download-grant` in `getBlobToFile` / `getBlob`; clear on run
  end. One-shot refresh-on-near-expiry-404 in `getBlobToFile`.
- `e2ee-remote.ts` — no change needed (it wraps a single `RboxApi`; `blobStore()` already returns
  the underlying store), but confirm the grant survives the `latest()`/`verifiedHead()` wrappers.

## Validation gate

- **Types:** root `bunx tsc --noEmit` + `cd apps/api && bunx tsc --noEmit` clean.
- **Server unit (`apps/api`, vitest cloudflare pool):**
  1. valid grant → blob served, **no `isEntitled`/D1 call** (spy on `dbFor`/`isEntitled`).
  2. expired grant → falls back to D1 path (served iff entitled), never 500.
  3. forged/tampered grant (bad MAC) → falls back to D1 path.
  4. grant whose `a` ≠ authenticated `p.accountId` → falls back to D1 path (not honored).
  5. no header → existing D1 path unchanged (regression pin).
  6. `latest()` includes a `grant`; with `RBOX_GRANT_KEY` unset, `latest()` still 200s with **no**
     `grant` field (best-effort mint) and GET falls to D1.
  7. grant unit tests mirroring `receipts.test.ts`: round-trip, `bad_mac`, `expired`, `future`,
     account `mismatch`, `malformed`, `bad_kid`, rotation (mint under PREV verifies), domain
     separation (a §23 **receipt** string fails `verifyGrant`, and a grant fails `verifyReceipt`).
- **Client (`bun test src/`):** `FakeRemote`/`FakeServer` extended to hand back a grant on
  `latest()` and assert the blob GETs carry `x-rbox-download-grant`; one-shot refresh on
  near-expiry 404.
- **Bench (dev only, per this doc's Benchmarking section):** deploy to `rbox-dev-api`, clone-sweep
  base vs head; success = `blob.get` §25 `d1Ms` → ~0 on the grant path and p50 → ~R2-only.
  **PR-only; do not deploy to prod** (download-auth protocol change; founder review + coordinated
  client/server ship).

---

## Benchmarking this change (against **dev**, not prod)

Validate on the **dev** worker `rbox-dev-api` — real Cloudflare D1/R2/DO, the only place the
latency/contention this change targets actually shows up (local Miniflare has ~0 network latency
and would hide it). The dev deploy is a **separate, manual** step — **do NOT push to `main` to
test**: push-to-`main` auto-deploys *prod* (`deploy-api.yml`).

```bash
# on a branch/worktree with the change (server + the client binary — this IS a protocol change):
cd apps/api && bunx wrangler deploy                  # → rbox-dev-api (dev only; prod untouched)
bun build --compile --target=bun-darwin-arm64 \
  ./src/cli/index.ts --outfile /tmp/rbox
# clone-sweep: time a fresh `rbox init --workspace <id>` into an empty dir, base vs head
```

- **Compare base vs head back-to-back** so dev's shared-instance noise cancels.
- **Success metric = the Target above:** read the §25 server split (`d1Ms`/`r2Ms`/`d1Calls` per
  `blob.get`) directly — the grant path should show `d1Calls=0` and `d1Ms≈0`.
- Only merge to `main` (→ prod) once proven on dev **and** the client+server ship is coordinated.

---

## Appendix — superseded deferrals (preserved for provenance)

> The two 2026-06-30 deferrals below are **superseded** by the §25-measured 185 ms/81% D1 data at
> the top of this doc. They are kept because their *reasoning* (measure before building; the
> Merkle-proof cost of ref-set scoping) directly shaped v4's decisions — v4 answers the first with
> real server metrics and sidesteps the second by choosing account-scope over ref-set-scope.

### DEFERRED — measured low-ROI (2026-06-30)

Codex review (NEEDS-WORK) + a measurement gate:
- **The pull D1 cost is small** *(by inference; §25 later measured it is not — see top)*.
  `blobGet`'s entitlement check is a single INDEXED `blob_refs` lookup — assumed ~20 ms
  uncontended. A real clone of 2000 blobs = ~15.1 s wall, of which per-blob D1 was inferred ~8%.
- **Inline membership is NOT D1-free (codex BLOCKER).** Checking `sha ∈ commit.blobRefs` per GET
  means re-fetching+parsing the (up to 1 MB) commit body — worse than the indexed read. A D1-free
  *ref-set-scoped* cap needs Merkle inclusion proofs.
  → **v4 resolution:** v4 does **not** do per-blob membership; account-scope makes the grant a pure
  signature check, so this BLOCKER does not apply.
- Codex's other findings (bind account/workspace + recompute; cap in a HEADER not the query
  string; pre-auth cap path; GC-condemned handling) → **all adopted by v4** (header, HMAC bind,
  best-effort mint with legacy fallback, GC-condemned unchanged).

### CONFIRMED DEFERRED — direct measurement (2026-06-30)

A download-concurrency sweep (savvy-core, 4287 blobs, dev) showed clone wall falling monotonically
as concurrency rose (32→128) with no plateau, concluding download *throughput*, not the
entitlement read, bounded the clone — so §27 was deferred and the concurrency default bumped
32→64 (`apply.ts`).
→ **v4 resolution:** that sweep measured *wall-clock throughput*, which is dominated by R2
transfer and masks the *per-op* D1 latency. §25's per-op split now isolates the entitlement read
at **185 ms/81% of `blob.get` p50** — a serialized single-threaded-D1 cost the throughput sweep
could not see. Both levers are real and independent: higher concurrency shrinks wall time; the
grant removes the 81%-of-p50 D1 serialization point. §27 is now justified on measured server-side
data.
