# Deployments

Canonical record of how each rbox surface ships. Referenced from `CLAUDE.md`
(auto-loaded) and `AGENTS.md` — update THIS file when pipelines change.

## API worker (`apps/api`) — Cloudflare Workers Builds (git integration)

Deploys are handled by **Cloudflare's Workers Builds git integration**
(connected in the Cloudflare dash; configured by the founder), NOT GitHub
Actions — the old `deploy-api.yml` was removed 2026-07-03.

Workers Builds config (dash-only; recorded 2026-07-10):

| Setting | Value |
|---|---|
| Root directory | `apps/api` |
| Build watch paths | `apps/api/**` |
| Production branch | `main` |
| Build command | `npx wrangler d1 migrations apply rbox-prod-db --remote --env production` |
| Deploy command | `npx wrangler deploy --env production` |
| Version command | `npx wrangler versions upload --env production` |

Consequences:

- **Prod D1 migrations auto-apply on every `main` merge touching
  `apps/api/**`** — new migration files ship themselves. Migration filenames
  are append-only; never rename applied ones (`apps/api/migrations/README.md`).
- The **dev DB (`rbox-dev-db`) has no such hook** — apply dev migrations
  manually: `cd apps/api && npx wrangler d1 migrations apply rbox-dev-db --remote`.
- **Workers Builds runs no tests** — PR CI (`ci.yml`: typecheck + full test
  suites) is the ONLY test gate before prod.

## Web dashboard (`apps/web`) — GitHub Actions

`.github/workflows/deploy-web.yml`: on `main` pushes touching `apps/web/**` →
build + `wrangler pages deploy` → **`rbox-app` / `app.rbox.to`**, gated on the
`check` + `test` jobs.

## CLI binaries — GitHub Actions on `v*` tags

`.github/workflows/release.yml`: build/sign/publish the `rbox` binaries to R2,
then upload the tagged checkout's `CHANGELOG.md` to
`rbox-releases/releases/changelog.md` and trigger the `rbox-home` Pages deploy
hook. The API exposes the source at `https://api.rbox.to/changelog.md`; Astro
renders it at `https://rbox.to/changelog/` during that rebuild.

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

Deploy worker changes to **dev** and verify before they reach prod:
`cd apps/api && npx wrangler deploy` → `rbox-dev-api`. Run the dashboard
locally against the dev worker (`cd apps/web && npm run dev` uses
`.env.development` → `rbox-dev-api.brian-via.workers.dev` + dev Clerk
`cosmic-phoenix-51`). **Never point local UI builds at the prod API** —
`npm run build` bakes in prod + `pk_live` and is only for the Pages deploy.
Remember: a merge to `main` ships prod automatically.
