# CI/CD release setup — one-time runbook

The release pipeline (`.github/workflows/release.yml`, design §14) builds the four
standalone `rbox` binaries, signs the version manifest with an offline Ed25519
key, and publishes to the `rbox-releases` R2 bucket. `rbox upgrade` verifies that
signature against the key embedded in `src/cli/release-key.ts`.

This file is the checklist to make the pipeline actually runnable. Nothing here is
in code because it's all secrets/repo-settings that must live outside git.

## Current state (read before cutting a real release)

- **Signing key** — keyId `f98abd21b9ea06b3`, pubkey embedded in
  `src/cli/release-key.ts`. The private key is **only** in the local gitignored
  file `release-private-key.local.secret` (worktree). It is NOT yet in GitHub.
- **`rbox-releases` bucket** — exists, but holds only a **test** `v0.0.2`
  `linux-x64` artifact from live-testing. The first real release supersedes it.
  macOS + arm64 artifacts do **not** exist yet, so `curl … | sh` on those
  platforms 404s until a real multi-platform release is cut. Don't advertise the
  installer publicly until then.
- **Routes are live** on both `rbox-dev-api` and `api.rbox.to`: `/version`,
  `/version.sig`, `/install.sh`, `/bin/<name>`, `/bin/v<ver>/<name>`.

## 1. Back up the signing key (do this first)

The embedded pubkey is permanent — if the private key is lost, **no future
release can ever be signed for existing installs** (they only trust this key).

- Copy `release-private-key.local.secret` somewhere durable and offline
  (password manager / hardware-backed store). Two independent copies.
- It contains `RBOX_RELEASE_PRIVATE_KEY` (Ed25519 pkcs8, base64url) and
  `RBOX_RELEASE_KEY_ID=f98abd21b9ea06b3`.

## 2. Cloudflare API token (least privilege)

Create a **scoped** token at dash.cloudflare.com → My Profile → API Tokens →
Create Token → Custom:

- Permission: **Account → Workers R2 Storage → Edit**.
- Account Resources: **this account only**.
- (R2 token scoping can't pin a single bucket in the UI today, so the manual
  approval gate in step 4 is what bounds blast radius — keep it.)

Note the token value and your **Account ID** (dash URL / Workers overview).

## 3. GitHub: create the `release` environment

Repo → Settings → Environments → **New environment** named exactly `release`
(the workflow's `environment: release` binds to it):

- **Required reviewers**: add yourself (this is the manual approval gate; the
  signing key is only readable while a run is approved).
- **Deployment branches**: restrict to protected tags / `main` if desired.

Add these **environment secrets** (Settings → Environments → release → Secrets):

| Secret | Value |
|--------|-------|
| `RBOX_RELEASE_PRIVATE_KEY` | the b64url pkcs8 private key from step 1 |
| `RBOX_RELEASE_KEY_ID` | `f98abd21b9ea06b3` |
| `CLOUDFLARE_API_TOKEN` | the scoped R2-edit token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | your account id |

Attach them to the **environment**, not the repo, so they're only exposed to the
approved release job.

## 4. Protect the `v*` tags

Repo → Settings → Rules → Rulesets (or Settings → Tags) → add a rule matching
`v*`:

- Restrict creation/deletion to maintainers.
- This is what stops an attacker who gets push access from minting a malicious
  signed release by pushing a tag.

The third-party actions in the workflow are already pinned to commit SHAs
(`actions/checkout` v4.2.1, `oven-sh/setup-bun` v2.1.3) — re-verify the SHA if you
bump the trailing version comment.

## 5. Cutting a release

```sh
# 1. bump the version in the repo (must match the tag — the workflow enforces it)
#    edit package.json "version" and src/cli/version.ts RBOX_VERSION to e.g. 0.1.0
git commit -am "release: v0.1.0"
git tag v0.1.0
git push origin main --tags
```

Pushing the `v0.1.0` tag triggers the workflow. It:

1. installs frozen deps, asserts `tag == package.json == src/cli/version.ts`,
2. runs the full test + typecheck suite **before** touching the signing key,
3. waits for your manual approval (the `release` environment gate),
4. builds all four targets, signs the manifest, fetch-back-verifies the uploaded
   shas, then publishes `version.json` + `.sig` **last** (so clients never see a
   manifest pointing at a not-yet-uploaded binary).

## 6. Verify a release

```sh
curl -s https://api.rbox.to/version | jq          # version + per-platform sha256
curl -fsSL https://api.rbox.to/install.sh | sh    # installs ~/.rbox/bin/rbox
rbox --version                                    # matches the tag
rbox upgrade                                       # "already up to date"
```

A tampered channel is caught client-side: a bad/garbage signature, a
manifest→artifact-path mismatch, or a sha256 mismatch all abort with a security
refusal and leave the installed binary untouched (covered by `upgrade.test.ts`
and live-verified on a real host).

## Key rotation (future)

`RELEASE_KEYS` is an array. To rotate: add the new pubkey as a second entry,
ship that in a release signed by the **old** key (so installs learn the new key),
then once adoption is high, sign with the new key and drop the old entry.
