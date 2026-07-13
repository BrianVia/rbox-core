# Prior Art: haydenbleasel/files-sdk

> Notes from reading https://github.com/haydenbleasel/files-sdk (cloned to `/tmp/files-sdk`).
> It's a unified storage SDK over ~30 providers (S3, **R2**, GCS, Azure, Backblaze, Dropbox, …) with
> composable feature plugins. Several of its layers are *exactly* what rbox's blob/sync layer needs,
> and a few of its design choices are better than what's currently in `rbox-architecture-v2.md`.

## TL;DR — what to actually do with this

1. **Steal the envelope-encryption design** (DEK-per-object, KEK-wrapped). It's better than the passphrase-derived-key model in v2. See §1 — it changes a v2 decision.
2. **Add a trash tier before GC.** Soft-delete → `.trash/` → purge is a cheap safety net for sync-driven deletes. See §4.
3. **Adopt the serializable resumable-upload token.** The daemon will die mid-upload (Docker restarts, laptop sleeps); resuming from a persisted token is the difference between robust and toy. See §5.
4. **Confirmed: never compare mtime for sync.** files-sdk deliberately excludes `lastModified` from its sync comparator for the same reason v2 flagged. See §3.
5. **Buy-vs-build:** files-sdk could *be* rbox's server-side storage layer (R2 + dedup + encryption + versioning + soft-delete + resumable). Evaluate before hand-rolling R2 calls. See §7.

---

## §1 — Envelope encryption (DEK/KEK) — supersedes v2's key model

`src/encryption/index.ts`. Scheme `aes-gcm/envelope/v1`:

- Each object gets a **fresh random DEK** (data encryption key) that encrypts the body with AES-256-GCM.
- A **master KEK** (the key you hold) "wraps" (encrypts) that DEK.
- The **wrapped DEK + both IVs ride along in the object's metadata**. On download, unwrap DEK with KEK, then decrypt body.
- GCM authenticates the body, the wrapped DEK, and the IV — tampering is detected. (They even AAD-bind `fsenc_size`.)

Why this beats v2's "derive one key from a passphrase and encrypt directly":
- **KEK rotation is cheap** — re-wrap the small DEKs, never re-encrypt the bodies.
- **`copy`/`move` just work** — the wrapped DEK travels with the object.
- Per-object key isolation: a leaked DEK exposes one object, not the workspace.

Their own threat-model note, paraphrased: *"if cross-tenant ciphertext splicing is in your threat model, isolate tenants with separate KEKs."* → For rbox that means **one KEK per workspace** (or per account), derived from the user passphrase / device key. The DEKs are random per blob.

### The tension this creates with dedup (important)
Random per-object DEK → identical plaintext produces **different ciphertext** → no ciphertext-level dedup. files-sdk accepts that (its dedup and encryption are separate plugins).

For rbox, resolve it explicitly — two coherent options:
- **(A) Convergent encryption** (v2's current call): DEK = `HKDF(workspace_KEK, plaintext_sha256)` instead of random. Identical plaintext → identical ciphertext → dedup works within the workspace, at the cost of leaking file-equality within that workspace. Keep envelope's *structure* (wrapped key in metadata) but make the DEK deterministic.
- **(B) Random DEK (files-sdk style), dedup on plaintext hash only.** Manifest identity is still `plaintext_sha256`, but two identical files owned by the same workspace each store their own ciphertext blob — no storage dedup under E2EE. Simpler, leaks nothing, costs storage.

**Recommendation:** Tier-0 (server-side) keeps content-addressed dedup as-is. Tier-1 (E2EE) uses **(A) convergent + envelope structure** so E2EE workspaces still dedup. Document the equality-leak. This is a refinement of v2 §Encryption, not a reversal.

---

## §2 — Plugin/middleware architecture

The whole SDK is a thin provider interface (`upload`/`download`/`list`/`head`/`delete`/`copy`/`move`) with **composable plugins** layered via a `PluginNext` chain (`dedup`, `encryption`, `versioning`, `soft-delete`, `compression`, `cache`, `failover`, `tracing`, `usage`, `audit`). Each plugin:
- wraps the operation, can transform body/metadata in and out,
- hides its own bookkeeping keys from `list()` (e.g. dedup blobs under `.dedup/`, versions under `.versions/`),
- stashes state in object **metadata** with a namespaced prefix (`fsenc_`, `fsdedup_`).

**Glean for rbox:** model the server storage layer as a thin R2 provider + ordered middleware, not a monolith. Ordering matters and is a real design decision — e.g. compression *before* encryption (encrypted data won't compress), dedup relative to encryption per §1.

---

## §3 — `sync` comparator confirms the mtime warning

`src/internal/sync.ts` reconciles a destination against a source (skip-if-identical, optional prune, dryRun). Its `compare` is `"etag" | "size" | fn` — and the comment is explicit:

> *"`lastModified` is deliberately not used: the destination stamps its own upload time, so it never matches the source after a sync — comparing it would re-upload everything on every run."*

This is exactly v2's "key sync off content hash, not mtime; use mtime only as a local fast-path." Independent confirmation. Also note their etag caveat: **etags aren't comparable across providers or for multipart objects** — so rbox should compare on its own `sha256`, never on R2 etags.

Other reusable shapes from `sync`: `dryRun` plan preview, `onProgress` per-key callbacks (`uploaded`/`skipped`/`deleted`), `prune` as an explicitly-destructive opt-in. Good CLI ergonomics to copy for `rbox status --dry-run`.

---

## §4 — Soft-delete trash tier (add this to rbox)

`src/soft-delete/index.ts`: `delete` moves the object to `.trash/<key>`; `trashed()` lists, `restore(key)` brings it back, `purge(key?)` is the only real delete. Hidden from normal `list`.

**Glean:** a sync product *will* propagate deletes across machines, and a propagated delete is the scariest operation there is ("my laptop's rm wiped my desktop"). A trash tier means a synced delete is recoverable until GC/purge. Pairs perfectly with v2's reachability GC: unreachable blobs go to trash first, purge after a grace period. Cheap insurance.

---

## §5 — Resumable uploads with a serializable session token

`src/internal/resumable.ts`: a provider-agnostic orchestrator (chunk slicing, parallel/sequential dispatch, pause gating, per-chunk retry, progress) over a thin per-provider `ResumableDriver`. The key idea: `UploadControl.toJSON()` produces a **serializable token** you persist (disk/db) and rehydrate with `UploadControl.from()` to **resume across process restarts / crashes**.

Note the per-provider resume primitive differs: **S3/R2 track discrete multipart parts** (part size pinned in the token), while GCS/OneDrive/Dropbox track a byte offset against a session URL.

**Glean for rbox:** the daemon is long-running and *will* be killed mid-upload (container restart, laptop sleep, network drop). Persist the resumable session token into `.rbox/state/uploads/` and resume — don't re-hash and re-upload a 500MB blob from zero. This belongs in Phase 2/3 of the build plan.

---

## §6 — Receipts (provenance) → maps to rbox's audit/integrity

`src/internal/receipts.ts`: opt-in provenance record per mutating op (`upload`/`delete`/`copy`/`move`) — op, key, timestamp, and **optionally** `sha256` (gated separately because hashing has a per-call cost: `receipts: true` vs `receipts: { sha256: true }`).

**Glean:** rbox's `audit_log` should record the same, and the "make the expensive integrity field opt-in" instinct is right — full plaintext-hash verification is the costly path (v2 already defers it to a queue). Receipts are also a clean way to feed the audit log without coupling it to business logic.

---

## §7 — Buy-vs-build: could files-sdk be rbox's storage layer?

It already provides, against R2: content-addressed dedup, envelope encryption, versioning (`.versions/<key>/<id>`, time-ordered ids, `limit`-based prune — *exactly* rbox's `versions`/`restore`), soft-delete, resumable upload, cross-provider `sync`, retries, receipts. That's most of rbox's server-side blob layer.

**Worth a real evaluation** before hand-rolling R2 calls in the Worker. Caveats:
- **✅ Workers runtime compat — VERIFIED (`files-sdk@2.0.0`).** Ran the R2 *binding* adapter + `encryption()` plugin under real `workerd` (`wrangler dev --local`, Miniflare R2). All passed: encryption applies (raw R2 bytes are ciphertext, envelope metadata `fsenc_dek/dek_iv/iv/scheme/size` present), `download` round-trips to plaintext, `head` reports the **logical (plaintext) size** without fetching the body, `delete` works. Web Crypto envelope encryption runs fine in `workerd`.
- **⚠️ Bundling gotcha (real, plan for it).** The published `dist` R2 chunk **statically imports** `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, and `@aws-sdk/s3-request-presigner` — so the source's "binding-only bundle stays lean / S3 loaded via dynamic import" claim does **not** hold in 2.0.0. `wrangler`/esbuild tries to resolve them at build time and fails. Two fixes: (a) install the three `@aws-sdk/*` packages (~500KB+, defeats the lean-bundle goal), or (b) **alias them to stubs** in `wrangler.jsonc` — binding mode never calls the S3 HTTP path at runtime, so empty stubs are safe (verified). The stub for `@aws-sdk/client-s3` must export all 13 named commands esbuild sees, or the build errors on missing exports. *(Smoke test + stubs live in scratchpad `fsdk-smoke/`.)*
- **Maturity** — `2.0.0` (more mature than the monorepo root's `0.0.0` suggested), changeset-driven. Pin the version; expect churn.
- **Manifest layer is still ours.** files-sdk is a *blob/object* layer. rbox's manifest model, DO sequencer, conflict engine, `.git` atomic snapshotting, and the daemon are not in scope for it — that's our IP. Use it for bytes, build the dev-aware brain on top.

Concrete versioning layout to copy regardless of buy-vs-build: snapshots at `.versions/<key>/<padded-ms-time>-<etag>`, ids sort chronologically, `limit` prunes oldest after each write.

---

## Misc quality bar worth matching
- ReDoS-safe slash normalization (`/^\/+|(?<!\/)\/+$/`) — they call it out explicitly.
- GCM AAD-binds metadata (`fsenc_size`) so size can't be tampered independently of the body.
- Plugins re-report **logical** (plaintext / pre-dedup) size in `head`/`list` without fetching the body — keep listings cheap.
