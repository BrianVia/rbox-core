# CI/CD release setup — one-time runbook

The release pipeline (`.github/workflows/release.yml`, designs §14/§150) builds
the three standalone `rbox` binaries, signs the version manifest with an
Ed25519 key held by the GitHub `release` environment, and publishes to the
`rbox-releases` R2 bucket. `rbox upgrade` verifies that signature against the
key embedded in `src/cli/release-key.ts`.

This file is the checklist to make the pipeline actually runnable. Nothing here is
in code because it's all secrets/repo-settings that must live outside git.

## Current prerequisites

Before cutting a release, confirm:

- the GitHub `release` environment contains `RBOX_RELEASE_PRIVATE_KEY`,
  `RBOX_RELEASE_KEY_ID`, `CLOUDFLARE_ACCOUNT_ID`, and the least-privilege
  `CLOUDFLARE_API_TOKEN`;
- the private key derives the public key embedded in
  `src/cli/release-key.ts`;
- the `protect-release-tags` ruleset still prevents deletion and force updates
  of `v*` tags; and
- the latest release workflow is green and the public `/version`,
  `/version.sig`, `/install.sh`, and `/bin/...` routes respond as expected.

There is no required-reviewer gate on the current private-repository plan. The
ability to push a protected `v*` tag is therefore the human authorization
boundary; the exact-SHA main CI gate is the automated test boundary.

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
- If R2 token scoping cannot pin a single bucket, keep the token restricted to
  this account and R2 edit access only.

Note the token value and your **Account ID** (dash URL / Workers overview).

## 3. GitHub: the `release` environment (already created)

The `release` environment exists and the workflow's `environment: release` binds
to it. On this free private plan it can't enforce required reviewers, so it's
purely a scoped secret container (see the no-approval-gate warning above).

Required secrets (set via `gh secret set … --env release`):

| Secret | Value | Status |
|--------|-------|--------|
| `RBOX_RELEASE_PRIVATE_KEY` | b64url pkcs8 private key | required |
| `RBOX_RELEASE_KEY_ID` | key id embedded in the manifest | required |
| `CLOUDFLARE_ACCOUNT_ID` | release bucket account | required |
| `CLOUDFLARE_API_TOKEN` | scoped R2-edit token from step 2 | required |

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

The third-party actions in the workflow are pinned to full commit SHAs with a
human-readable version comment. Re-verify the SHA whenever bumping that comment.

## 5. Cutting a release

```sh
# 1. add the newest released CHANGELOG.md heading and bump the version
#    in package.json and src/cli/version.ts (all must match the tag)
git commit -am "release: v0.1.0"
git push origin main
# Wait for CI on this exact main SHA to pass.
git tag v0.1.0
git push origin v0.1.0
```

Pushing the `v0.1.0` tag triggers the workflow. It:

1. asserts `tag == package.json == src/cli/version.ts`,
2. requires the successful `CI` run for the exact tagged SHA from a push to
   `main` (PR merge-preview runs do not qualify),
3. installs frozen all-platform dependencies, builds all three targets, and
   signs the manifest with the step-scoped release key,
4. smoke-tests every binary on its native target, then concurrently uploads and
   fetch-back-verifies immutable binaries before sequentially publishing latest
   aliases, `install.sh`, `version.json`, and `.sig` last.

There is no manual approval gate on the current private-repository plan. Pushing
main and the tag together is safe, but makes the release job poll for main CI;
the ordered flow above avoids paying for an idle release runner.

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
