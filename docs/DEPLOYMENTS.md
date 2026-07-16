# Deployments

Canonical record of how each rbox surface ships. Referenced from `CLAUDE.md`
(auto-loaded) and `AGENTS.md` — update THIS file when pipelines change.

## Branch model and production promotion

- **`main` is the integration branch.** PRs merge to `main` when CI is green.
  Nothing deploys from pushes or merges to `main`.
- **`production` is the deployed branch.** After verifying the candidate in
  dev, fast-forward the `production` branch to the commit at `main`:
  `git push origin main:production`.
- A promotion updates every production surface whose path filters match the
  promoted commits. Do not promote until the full `main` candidate is ready.

The `production` branch already exists on origin. Promotions are deliberately
explicit; do not commit directly to it or let it diverge from `main`.

## API worker (`apps/api`) — Cloudflare Workers Builds (git integration)

Deploys are handled by **Cloudflare's Workers Builds git integration**
(connected in the Cloudflare dash; configured by the founder), NOT GitHub
Actions — the old `deploy-api.yml` was removed 2026-07-03.

Workers Builds config (dash-only; production-branch change founder-applied):

| Setting | Value |
|---|---|
| Root directory | `apps/api` |
| Build watch paths | `apps/api/**` |
| Production branch | `production` |
| Build command | `npx wrangler d1 migrations apply rbox-prod-db --remote --env production` |
| Deploy command | `npx wrangler deploy --env production` |
| Version command | `npx wrangler versions upload --env production` |

Consequences:

- **Prod D1 migrations auto-apply only when a promotion to `production`
  touches `apps/api/**`** — new migration files ship as part of that promotion.
  Migration filenames are append-only; never rename applied ones
  (`apps/api/migrations/README.md`).
- The **dev DB (`rbox-dev-db`) has no such hook** — apply dev migrations
  manually: `cd apps/api && npx wrangler d1 migrations apply rbox-dev-db --remote`.
- **Workers Builds runs no tests** — PR CI (`ci.yml`: typecheck + full test
  suites) and dev verification must succeed before promotion.

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
consistency gate), commit `release: vX.Y.Z — …` on main, tag `v*`, push.
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

## Secrets (GitHub repo)

- `CLOUDFLARE_DEPLOY_TOKEN` — Workers Scripts:Edit + Cloudflare Pages:Edit
  (+ Account:Read); used by `deploy-web.yml`.
- `CLOUDFLARE_API_TOKEN` — R2-only; used by `release.yml`.
- `RBOX_HOME_DEPLOY_HOOK` — secret Cloudflare Pages deploy-hook URL for the
  `rbox-home` `main` branch; used by `release.yml` after changelog publication.
- Keep them DISTINCT (least privilege). The account id is hard-coded in the
  workflows (not a secret).

## Dev-first rule

Before promoting `main` to `production`, deploy worker changes to **dev** and
verify them:
`cd apps/api && npx wrangler deploy` → `rbox-dev-api`. Run the dashboard
locally against the dev worker (`cd apps/web && npm run dev` uses
`.env.development` → `rbox-dev-api.brian-via.workers.dev` + dev Clerk
`cosmic-phoenix-51`). **Never point local UI builds at the prod API** —
`npm run build` bakes in prod + `pk_live` and is only for the Pages deploy.
When the candidate is verified and CI is green, promote it explicitly with
`git push origin main:production`; production deploys and prod D1 migration
application happen from that branch update, not from the merge to `main`.

`rbox-admin` may adopt this integration/deployed-branch split in the future;
it is not part of the current pipeline change.
