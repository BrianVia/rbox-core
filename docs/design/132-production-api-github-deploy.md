# Design 132 — Production API GitHub deploy restoration

## Context

PR #294 splits integration (`main`) from deployment (`production`). The
founder is disconnecting the production Cloudflare Workers Builds git
integration, so production API delivery must return to a repository-owned,
test-gated GitHub Actions workflow. The development Workers Builds integration
continues watching `main`.

## Workflow

Restore `.github/workflows/deploy-api.yml`, based on its pre-`82ce14a` form,
with these current contracts:

- Trigger on pushes to `production` that touch `apps/api/**` or the workflow
  itself, plus manual dispatch. Guard the deploy job with
  `github.ref == 'refs/heads/production'`, matching `deploy-web.yml`, so a
  manual dispatch cannot migrate or deploy an arbitrary checkout. Retain
  `deploy-api-prod` concurrency with no cancellation.
- Grant the workflow token only `contents: read`. Mirror `ci.yml`'s exact
  SHA-pinned checkout/setup/cache actions, Bun 1.3.14, Node 24, dependency and
  TypeScript/Vitest caches (without the matrix conditions), and frozen root
  install. Gate with the repository commands `bun run typecheck` and
  `bun run test:api`.
- Only after the gate succeeds, run these commands sequentially from
  `apps/api`: production D1 migrations, Worker deploy, then version upload.
  Authenticate Wrangler through `CLOUDFLARE_API_TOKEN` sourced from the repo
  secret `CLOUDFLARE_DEPLOY_TOKEN`, and hard-code the existing Cloudflare
  account id as `CLOUDFLARE_ACCOUNT_ID`.
- Document the deploy token's least-privilege needs: Workers Scripts:Edit,
  D1:Edit, and Account:Read (with Pages:Edit also needed by the web workflow if
  the same token remains shared).

Step ordering is the safety property: tests -> migrations -> deploy -> version
upload. GitHub Actions' default fail-fast step semantics enforce it.

## Documentation

Update `docs/DEPLOYMENTS.md` and the deployment summary in `AGENTS.md` so they
record:

- production Workers Builds is disconnected in the dashboard by the founder;
- the restored workflow is production-branch/path triggered and test gated;
- production migrations precede deploy, which precedes version upload;
- development Workers Builds remains rooted at `./apps/api`, watches `main`,
  and runs the literal dashboard commands (`npx wrangler d1 migrations apply
  rbox-dev-db --remote`, `npx wrangler deploy`, and `npx wrangler versions
  upload`) automatically on every main merge;
- therefore the dev-first rule verifies that automatic dev deployment instead
  of instructing a manual dev deploy.

The branch summary must say that `main` deploys no **production** surface,
rather than the now-false claim that it deploys nothing at all. Current
deployment summaries outside the canonical file that directly contradict the
new arrangement are updated as part of the documentation consistency pass.

## Validation

- Run `actionlint` if installed. Otherwise use an available YAML 1.2 parser and
  explicitly inspect the Actions-specific `on.push.branches`, `paths`, and
  `workflow_dispatch` structure; a generic YAML 1.1 parse alone is inadequate.
- Run `bun run typecheck` and `bun run test:api`.
- Grep deployment documentation and workflow files for stale production
  Workers Builds/manual-dev guidance and verify the intended commands and
  branch filters.
