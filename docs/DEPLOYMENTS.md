# Deployments

Canonical record of how each rbox surface ships. Referenced from `CLAUDE.md`
(auto-loaded) and `AGENTS.md` — update THIS file when pipelines change.

## Branch model and production promotion

- **`main` is the integration branch.** PRs merge to `main` when CI is green.
  No production surface deploys from `main`; the DEV API Workers Builds
  integration does deploy automatically from it.
- **`production` is the deployed branch.** After verifying the candidate in
  dev, fast-forward the `production` branch to the commit at `main`:
  `git push origin main:production`.
- A promotion updates every production surface whose path filters match the
  promoted commits. Do not promote until the full `main` candidate is ready.

The `production` branch already exists on origin. Promotions are deliberately
explicit; do not commit directly to it or let it diverge from `main`.

## API worker (`apps/api`) — GitHub Actions (production)

`.github/workflows/deploy-api.yml` deploys production on pushes to
`production` touching `apps/api/**` (or the workflow itself), with a manual
dispatch option restricted to the `production` ref. It first runs
`bun run typecheck` and `bun run test:api`. Only after that gate passes does it
run, in order from `apps/api`:

1. `npx wrangler d1 migrations apply rbox-prod-db --remote --env production`
2. `npx wrangler deploy --env production`
3. `npx wrangler versions upload --env production`

GitHub Actions stops on the first failing step, so migrations never run before
tests pass, deployment never runs before migrations succeed, and version
upload never runs before deployment succeeds. Migration filenames are
append-only; never rename applied ones (`apps/api/migrations/README.md`).

The former **production** Cloudflare Workers Builds git integration is
**DISCONNECTED** in the Cloudflare dashboard by the founder. It must remain
disconnected so one promotion cannot race or duplicate the GitHub workflow.

## API worker (`apps/api`) — Cloudflare Workers Builds (DEV)

The DEV Workers Builds integration remains connected in the Cloudflare
dashboard and watches `main`. Every merge to `main` automatically deploys DEV,
using this founder-managed configuration:

| Setting | Value |
|---|---|
| Root directory | `./apps/api` |
| Watched branch | `main` |
| Build command | `npx wrangler d1 migrations apply rbox-dev-db --remote` |
| Deploy command | `npx wrangler deploy` |
| Version command | `npx wrangler versions upload` |

Workers Builds runs no tests. PR CI remains the pre-merge gate, and the
production workflow repeats typecheck plus the API Worker suite before any
production mutation.

## Web dashboard (`apps/web`) — Cloudflare Pages Builds (git integration)

The dashboard deploys via the **Cloudflare Pages git integration** (founder-
managed in the Cloudflare dashboard), NOT a GitHub Action — the former
`deploy-web.yml` used `wrangler pages deploy`, whose content-hash upload cache
intermittently dropped changed assets (a CSS/JS file would 404 as the SPA
fallback). Cloudflare builds the project itself and publishes the whole output,
avoiding that cache. Founder-managed config:

| Setting | Value |
|---|---|
| Production branch | `production` |
| Root directory | `apps/web` |
| Build command | `npm run build` (Cloudflare runs `npm ci` first) |
| Build output | `build` (SvelteKit `adapter-static`; NOT `.svelte-kit/cloudflare`) |
| Watch paths | include `apps/web`, exclude `package.json` |

`apps/web`'s `package-lock.json` must stay in sync for the Cloudflare build's
`npm ci` (Cloudflare uses npm 10.9.2 — regenerate the lock with that npm if it
drifts).

## CLI binaries — GitHub Actions on `v*` tags

`.github/workflows/release.yml` derives one of two channels from the tag's
semver. A bare version such as `v1.12.0` publishes `latest`; a prerelease such
as `v2.0.0-beta.1` publishes the opt-in `next` channel. Both share immutable
version-addressed binaries under `releases/v<version>/`. Stable publication
then updates the existing `releases/rbox-*` aliases, `releases/install.sh`,
`releases/version.json`, and `releases/version.json.sig`; it also uploads the
tagged checkout's `CHANGELOG.md` to `releases/changelog.md` and triggers the
`rbox-home` Pages deploy hook. Prerelease publication updates only
`releases/next/install.sh`, `releases/next/manifest.json`, and
`releases/next/manifest.json.sig` after the shared immutable upload. It never
reads or mutates the stable channel, changelog, or deploy hook.

The universal RboxBar zip is another signed manifest artifact published through
`scripts/release.ts`. Every channel publishes its immutable
`releases/v<version>/RboxBar-<version>.zip`; stable also updates
`releases/RboxBar.zip`, while prerelease deliberately leaves that stable alias
untouched. On macOS, `rbox upgrade` installs or updates RboxBar by default in the
existing system Applications location or the user's Applications directory.
Set `RBOX_NO_MENUBAR_APP=1` to skip menu-bar app management.

The API exposes the changelog at `https://api.rbox.to/changelog.md`; Astro
renders it at `https://rbox.to/changelog/` during the stable rebuild. CLI
releases remain tag-driven and are unaffected by the branch promotion model.

Release flow: bump `package.json` version + `CHECKED_IN_RBOX_VERSION`
(`src/cli/version.ts`, first quoted string is read by the workflow's
consistency gate), commit `release: vX.Y.Z — …` on main, run
`bun scripts/ux/regress.ts`, push `main`, and wait
for that exact SHA's main CI run to pass. Then tag that commit `v*` and push the
tag. A simultaneous main+tag push is safe, but the release runner waits for the
exact-SHA main CI verdict before installing build dependencies or receiving the
step-scoped signing key. PR merge-preview results never qualify.
Fleet upgrade after the run goes green:
`curl -fsSL https://rbox.to/install.sh | sh` then `rbox stop && rbox start`
(run from inside the workspace; binary at `~/.rbox/bin/rbox`).
For founder-fleet prerelease dogfood, use
`curl -fsSL https://rbox.to/next/install.sh | sh` or
`rbox upgrade --channel next`. The selection persists in
`<installed-rbox>.channel.json`, so later unflagged upgrades continue checking
`next`. Use `rbox upgrade --channel latest` to switch back after stable catches
up. Running the stable installer also clears a persisted `next` selection;
running the next installer writes it.
The installer is intentionally a binary swap only, so fleet/install-script
deployments retain that explicit stop/start step. The managed `rbox upgrade`
command instead snapshots every live daemon under `~/.rbox/daemons`, waits for
each to stop, and restarts every safely bound desired workspace with its
existing pull-only setting. It reports all workspace outcomes and exits
non-zero if any live runtime cannot be restarted safely.
Update `CHANGELOG.md` per release.

For a stable tag, the tag version must be the first released heading after
`[Unreleased]` or the release fails. Prerelease tags skip the changelog heading
gate and changelog publication. Publish workflows are serialized, and each
channel refuses to replace its own newer live manifest. If publication fails
while the one-day `rbox-dist` artifact is available, rerun the publish job.
Later, publish from the exact protected tag.
For changelog-only recovery:

```sh
bunx wrangler@4.107.0 r2 object put rbox-releases/releases/changelog.md \
  --file=CHANGELOG.md --content-type='text/markdown; charset=utf-8' --remote
curl --fail --silent --show-error --request POST "$RBOX_HOME_DEPLOY_HOOK" >/dev/null
```

The release publisher uploads and fetch-verifies immutable versioned binaries
concurrently, then updates the selected channel's installer, manifest, and
detached signature sequentially (plus the binary aliases on `latest`). Any
immutable transfer or hash failure prevents all mutable channel changes.

## Oversized Stripe webhook recovery

`POST /v1/stripe/webhook` is bounded by `RBOX_STRIPE_WEBHOOK_MAX_BYTES` (default
1 MiB). Its overflow anomaly is only a notification; the sender-controlled
Content-Length and incomplete counted bytes are never evidence for raising the
cap. After Stripe-side corroboration that a legitimate event exceeded the
bound, raise the positive integer through the existing Wrangler environment
configuration, deploy that configuration, and manually resend the event from
the Stripe dashboard within Stripe's 15-day manual resend window.

There is no local replay, fetch-by-id, reconciliation, or admin endpoint for
this flow. Use Stripe's existing dashboard resend after the configuration is
deployed.

## Blob catalog repair safety

Any manual catalog repair that clears a blob's `present` flag must also
prune-mark every affected account ref before the next commit, or be followed by
`rbox sync --verify` / one push with `RBOX_PREFLIGHT_FULL=1`. Delta preflight
intentionally checks newly introduced and server-requested recovery addresses;
the commit admission fence catches prune-marked carried refs, but an unmarked
manual `present=0` correction is outside that safety envelope.

## Secrets (GitHub repo)

- `CLOUDFLARE_DEPLOY_TOKEN` — Workers Scripts:Edit + D1:Edit + Cloudflare
  Pages:Edit (+ Account:Read); used by `deploy-api.yml` (web now deploys via the Cloudflare Pages git integration).
- `CLOUDFLARE_API_TOKEN` — R2-only; used by `release.yml`.
- `RBOX_HOME_DEPLOY_HOOK` — secret Cloudflare Pages deploy-hook URL for the
  `rbox-home` `main` branch; used by `release.yml` after changelog publication.
- Keep them DISTINCT (least privilege). The account id is hard-coded in the
  workflows (not a secret).

## Dev-first rule

Every merge to `main` automatically runs the DEV Workers Builds migration,
deploy, and version commands above. Before promoting `main` to `production`,
wait for that DEV deployment and verify `rbox-dev-api`. Run the dashboard
locally against it (`cd apps/web && npm run dev` uses
`.env.development` → `rbox-dev-api.brian-via.workers.dev` + dev Clerk
`cosmic-phoenix-51`). **Never point local UI builds at the prod API** —
`npm run build` bakes in prod + `pk_live` and is only for the Pages deploy.
When the candidate is verified and CI is green, promote it explicitly with
`git push origin main:production`; the test-gated production migration,
deployment, and version upload happen from that branch update, not from the
merge to `main`.

`rbox-admin` may adopt this integration/deployed-branch split in the future;
it is not part of the current pipeline change.
