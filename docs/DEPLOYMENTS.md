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

## Web dashboard (`apps/web`) — GitHub Actions

`.github/workflows/deploy-web.yml`: on `production` pushes touching
`apps/web/**` → build + `wrangler pages deploy` → **`rbox-app` /
`app.rbox.to`**, gated on `check` + `test`.

## CLI binaries — GitHub Actions on `v*` tags

`.github/workflows/release.yml`: build/sign/publish the `rbox` binaries to R2,
then upload the tagged checkout's `CHANGELOG.md` to
`rbox-releases/releases/changelog.md` and trigger the `rbox-home` Pages deploy
hook. The API exposes the source at `https://api.rbox.to/changelog.md`; Astro
renders it at `https://rbox.to/changelog/` during that rebuild. CLI releases
remain tag-driven and are unaffected by the branch promotion model.

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
The installer is intentionally a binary swap only, so fleet/install-script
deployments retain that explicit stop/start step. The managed `rbox upgrade`
command instead snapshots every live daemon under `~/.rbox/daemons`, waits for
each to stop, and restarts every safely bound desired workspace with its
existing pull-only setting. It reports all workspace outcomes and exits
non-zero if any live runtime cannot be restarted safely.
Update `CHANGELOG.md` per release.

The tag version must be the first released heading after `[Unreleased]` or the
release fails. Publish workflows are serialized and refuse to replace a newer
live manifest. If publication fails while the one-day `rbox-dist` artifact is
available, rerun the publish job. Later, publish from the exact protected tag.
For changelog-only recovery:

```sh
bunx wrangler@4.107.0 r2 object put rbox-releases/releases/changelog.md \
  --file=CHANGELOG.md --content-type='text/markdown; charset=utf-8' --remote
curl --fail --silent --show-error --request POST "$RBOX_HOME_DEPLOY_HOOK" >/dev/null
```

The release publisher uploads and fetch-verifies immutable versioned binaries
concurrently, then updates latest aliases, `install.sh`, manifest, and detached
signature sequentially. Any immutable transfer or hash failure prevents all
mutable channel changes.

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

## Secrets (GitHub repo)

- `CLOUDFLARE_DEPLOY_TOKEN` — Workers Scripts:Edit + D1:Edit + Cloudflare
  Pages:Edit (+ Account:Read); used by `deploy-api.yml` and `deploy-web.yml`.
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
