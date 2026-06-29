# Design 14 — CI/CD release builds + signed `rbox upgrade`

**Status:** DRAFT for codex adversarial (supply-chain / update-integrity) review.
Goal: tag a release → CI builds the 4 standalone binaries, **signs** a release
manifest, and publishes everything to R2; `rbox upgrade` self-updates the binary
in place, **verifying a signature against an embedded public key** (the update
channel must NOT be a blind-trust RCE vector — we just shipped a zero-knowledge
product; the updater has to be at least as careful).

## 0. Today
- `scripts/install.sh` downloads `<BASE>/bin/rbox-<os>-<arch>` (worker serves it
  from R2 `releases/rbox-<os>-<arch>`, name-validated). `/install.sh` likewise.
- Binaries are built locally (`bun build --compile --target=…`) + uploaded by
  hand. No version metadata, no integrity, no self-update.

## 1. Versioning
- Source of truth: a git tag `vMAJOR.MINOR.PATCH` (and `package.json` `version`).
- **Embed at build time**: CI writes `src/cli/version.ts`
  (`export const RBOX_VERSION = "X.Y.Z"`) from the tag before `bun build`. `rbox
  --version` prints it; `rbox upgrade` compares it. (No env/runtime lookup — the
  running binary knows its own version.)

## 2. Release artifacts (R2 `releases/`)
- `rbox-{darwin,linux}-{arm64,x64}` — the 4 binaries (already served by `/bin/:name`).
- `install.sh` (already served by `/install.sh`).
- **`version.json`** (NEW) — the signed manifest:
  ```json
  { "version": "X.Y.Z",
    "artifacts": { "rbox-darwin-arm64": "<sha256-hex>", ...4 entries },
    "releasedAt": "<iso8601>" }
  ```
- **`version.json.sig`** (NEW) — `Ed25519.sign(releasePrivKey, sha256(version.json bytes))`,
  b64url. The release private key is OFFLINE/CI-only; its **public key is embedded
  in the binary** (`src/cli/release-key.ts`).

## 3. Worker route
`GET /version` → serves R2 `releases/version.json` (+ a `/version.sig` or fold the
sig into the JSON as `sig`). Public, cacheable (short TTL). `/bin/:name` unchanged.

## 4. `rbox upgrade` (the client, the careful part)
1. `GET <BASE>/version` → manifest JSON + its signature.
2. **Verify the signature** over the exact manifest bytes against the embedded
   `RBOX_RELEASE_PUBKEY` (Ed25519). Mismatch → abort, change nothing.
3. **Forward-only**: parse `manifest.version`; if `<= RBOX_VERSION` (semver) →
   "already up to date", exit 0. Refuse to "upgrade" to an older/equal version
   (anti-rollback: a stale-but-validly-signed manifest can't pin you back).
4. Resolve `rbox-<os>-<arch>`; download `<BASE>/bin/<name>` to a temp file **in the
   same directory as the running executable** (so the final rename is atomic on
   one filesystem).
5. **Verify** `sha256(temp) === manifest.artifacts[name]`; mismatch → delete temp,
   abort.
6. `chmod 0755` the temp; **atomic `rename(temp, process.execPath)`** — on
   Unix this replaces a running binary safely (the live process keeps its inode;
   the next `rbox` uses the new file). Print "upgraded to X.Y.Z — re-run rbox".
7. **Fail closed + clearly** on: non-HTTPS base, network error, signature/sha
   mismatch, **non-writable exe dir** (e.g. `/usr/local/bin` without perms →
   "re-run with sudo or re-run the installer"), or running from a non-file path
   (dev `bun run`). Never partially overwrite; temp is always cleaned up.

## 5. CI workflow (`.github/workflows/release.yml`)
Trigger: push tag `v*`. Single `ubuntu-latest` job:
1. `oven-sh/setup-bun`.
2. Derive `VERSION` from the tag; write `src/cli/version.ts`.
3. For each target in {bun-darwin-arm64, bun-darwin-x64, bun-linux-arm64,
   bun-linux-x64}: `bun build --compile --target=<t> ./src/cli/index.ts --outfile
   dist/rbox-<os>-<arch>`. (Bun cross-compiles all four from linux.)
4. Compute sha256 of each; assemble `version.json`.
5. **Sign**: `version.json.sig = Ed25519.sign(secrets.RBOX_RELEASE_PRIVATE_KEY,
   sha256(version.json))` (a tiny bun script, key from the GH secret, never logged).
6. Upload binaries + `install.sh` + `version.json` (+ sig) to R2 via
   `wrangler r2 object put` (auth: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
   secrets) under `releases/`. Optionally also attach to a GitHub Release.
- **GH secrets required**: `CLOUDFLARE_API_TOKEN` (R2 write, scoped), 
  `CLOUDFLARE_ACCOUNT_ID`, `RBOX_RELEASE_PRIVATE_KEY` (Ed25519, b64url).

## 6. Release key bootstrap (one-time, human)
Generate an Ed25519 keypair offline; put the private key in the GH Actions secret;
commit the public key as `src/cli/release-key.ts`. Document rotation: ship a new
public key in a release, then sign future manifests with the new private key (old
binaries can't verify new releases signed by a rotated key → they `rbox upgrade`
once via the last key-compatible release; full key-rotation UX is future).

## 7. Threat model (state honestly)
- **Channel compromise (R2/worker)**: an attacker who controls the channel can
  serve binaries, but CANNOT forge `version.json.sig` without the offline release
  key → `rbox upgrade` rejects unsigned/mis-signed manifests. This is the core
  protection. (`install.sh` first-install is still TOFU over HTTPS — a channel
  compromise at first install is unprotected; documented, same as every
  `curl | sh`. `upgrade` is the protected path.)
- **Rollback/freeze**: forward-only version check blocks downgrade-pinning to a
  validly-signed older release; an attacker can still WITHHOLD updates (freeze) —
  unfixable without a transparency log / monotonic timestamp service (future).
- **Key compromise**: if the release private key leaks, attacker can sign
  malicious updates → rotate (key in one place: the GH secret). Keep it offline-
  generated, GH-secret-only, never in the repo/logs.
- **Local**: atomic rename avoids a torn binary; non-writable dir fails closed.

## 8. Verification
- Unit: signature verify (valid → ok; tampered manifest/sig → reject); semver
  forward-only (older/equal → no-op); sha mismatch → abort; embedded-pubkey parse.
- Dry-run `rbox upgrade --check` (report available version, no write).
- Manual: tag a `v0.0.2` on a test ref → CI publishes → `rbox upgrade` on a
  built binary pulls + verifies + replaces; `rbox --version` shows the new version.
- Negative: corrupt the served binary (sha fail) / re-sign with a wrong key (sig
  fail) → upgrade refuses, original binary intact.

## 9. Open questions for codex
1. Signature design: sign `sha256(version.json)` vs sign the raw bytes; is binding
   per-artifact sha into the signed manifest enough (vs signing each binary)?
2. Forward-only by embedded `RBOX_VERSION` — adequate anti-rollback, or do we need
   a monotonic counter / min-version floor in a separate signed file?
3. Atomic self-replace on the running executable: `rename` over `process.execPath`
   — correct across the install targets (`~/.rbox/bin`, `/usr/local/bin`)? Windows
   is out of scope (darwin/linux only) — confirm.
4. R2 upload auth in CI: `wrangler r2 object put` with a scoped API token vs the S3
   API — least-privilege token scope?
5. First-install TOFU gap (install.sh) — accept as documented, or add manifest
   verification to install.sh too (it has no embedded key yet)?
6. Anything that makes the updater a supply-chain RCE vector or bricks a user's binary.
