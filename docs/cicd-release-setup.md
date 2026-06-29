# CI/CD release setup — one-time runbook

The release pipeline (`.github/workflows/release.yml`, design §14) builds the four
standalone `rbox` binaries, signs the version manifest with an offline Ed25519
key, and publishes to the `rbox-releases` R2 bucket. `rbox upgrade` verifies that
signature against the key embedded in `src/cli/release-key.ts`.

This file is the checklist to make the pipeline actually runnable. Nothing here is
in code because it's all secrets/repo-settings that must live outside git.

## Status (2026-06-29)

Mostly done — **one step left**: the scoped Cloudflare token (step 2).

- [x] `release` GitHub Environment created.
- [x] `RBOX_RELEASE_PRIVATE_KEY`, `RBOX_RELEASE_KEY_ID`, `CLOUDFLARE_ACCOUNT_ID`
      set as `release` environment secrets (key verified to derive the embedded
      pubkey, so CI will sign releases clients accept).
- [x] `v*` tag protection ruleset active (no deletion / no force-update).
- [ ] **`CLOUDFLARE_API_TOKEN`** — create a scoped R2-write token (step 2) and:
      `gh secret set CLOUDFLARE_API_TOKEN --env release --repo BrianVia/rbox-core`
- [ ] First real multi-platform release cut (supersedes the test `v0.0.2`).

> ⚠️ **No approval gate.** Required-reviewer protection is a paid-plan feature and
> isn't available on this free private repo. The signing key lives in GitHub
> secrets gated only by "who can push a `v*` tag" (owner-only). If you want the
> key behind an approval wall, either upgrade the plan and add a required reviewer
> to the `release` env, make the repo public (free protection rules), or switch to
> local-only signing (`bun scripts/release.ts <ver>` — the key never leaves your
> machine).

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

## 3. GitHub: the `release` environment (already created)

The `release` environment exists and the workflow's `environment: release` binds
to it. On this free private plan it can't enforce required reviewers, so it's
purely a scoped secret container (see the no-approval-gate warning above).

Secrets already set (via `gh secret set … --env release`):

| Secret | Value | Status |
|--------|-------|--------|
| `RBOX_RELEASE_PRIVATE_KEY` | b64url pkcs8 private key | ✅ set |
| `RBOX_RELEASE_KEY_ID` | `f98abd21b9ea06b3` | ✅ set |
| `CLOUDFLARE_ACCOUNT_ID` | `d1d5680013391ca21665add23eee6426` | ✅ set |
| `CLOUDFLARE_API_TOKEN` | scoped R2-edit token from step 2 | ⏳ **you set this** |

```sh
gh secret set CLOUDFLARE_API_TOKEN --env release --repo BrianVia/rbox-core
# paste the token when prompted (or pipe it in)
```

## 4. Tag protection (`v*`) — already active

A repository ruleset (`protect-release-tags`) targets `refs/tags/v*` with
**deletion** and **non-fast-forward** blocked (admin can bypass for mistake
recovery). This stops a `v*` tag from being silently re-pointed to re-trigger a
release. On a single-owner private repo this is mostly belt-and-suspenders, but
it keeps releases immutable.

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
