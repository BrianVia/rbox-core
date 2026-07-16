# Review 132

## Round 1

### Verdict: revise, then implement

The design correctly captures the requested push/path triggers, existing
concurrency contract, current Bun/Node/install/cache setup, exact root gate
commands, Wrangler working directory/authentication, and the required
tests -> migrations -> deploy -> version-upload ordering. It also correctly
recognizes that `AGENTS.md` must change even though the user named
`docs/DEPLOYMENTS.md`, because the branch's current summary would otherwise
remain factually stale.

Issues to resolve before implementation:

1. **Production safety: define `workflow_dispatch` branch semantics.** As
   written, the design permits an implementation that manually dispatches
   from `main` or an arbitrary feature ref and then applies production D1
   migrations and deploys that unpromoted checkout. The current production
   dashboard workflow has a job-level
   `if: github.ref == 'refs/heads/production'` guard. Require the same guard
   here (manual operators select `production` in the dispatch UI), or state an
   equally strong mechanism. Merely filtering `push.branches` does not
   constrain `workflow_dispatch`.

2. **Make the action pinning contract explicit.** “Mirror `ci.yml`'s pinned
   Bun/Node setup” could be read as pinning only versions in `with:`. Current
   `ci.yml` pins checkout, setup-bun, setup-node, and cache actions to full
   commit SHAs. The restored workflow should mirror those exact action refs,
   Bun 1.3.14, Node 24, the two conditional-cache definitions adapted to the
   single job (without matrix-only `if`s), and `bun install
   --frozen-lockfile`. The historical `@v4`/`@v2` action tags are only a base,
   not current convention.

3. **Specify least-privilege workflow permissions.** Add `permissions:\n  contents: read`
   to the intended workflow. `ci.yml` already does this, and a deploy job
   receiving a production-capable Cloudflare token should not inherit a
   repository's possibly broader default `GITHUB_TOKEN` permissions. This is
   defense in depth and does not interfere with checkout.

4. **Avoid a docs contradiction about `main`.** The current branch-model
   section says “Nothing deploys from pushes or merges to `main`,” which will
   become false once the retained DEV Workers Builds integration is recorded.
   The design's documentation bullets imply the correction but should name
   this exact stale sentence: `main` does not deploy **production**, while
   applicable `apps/api` merges automatically deploy DEV. Likewise replace
   the current manual dev migration/deploy instructions and the `AGENTS.md`
   claim that prod migrations run “as part of the Workers Builds command.”

5. **Record DEV configuration literally and distinguish it from the retired
   PROD integration.** The final docs should say the founder has disconnected
   the production Workers Builds git integration, while DEV remains connected,
   watches `main`, uses root `./apps/api`, and has the exact three dash commands
   supplied by the user. “Every relevant main merge” should be clarified as
   every applicable API-changing merge if a watch-path filter exists; do not
   imply unrelated docs-only merges necessarily start a Worker build unless
   that is actually the dashboard behavior.

6. **Validation must use a GitHub-Actions-aware YAML check.** Generic YAML 1.1
   parsers can silently coerce the top-level `on` key to boolean and are not a
   sufficient validation by themselves. Prefer `actionlint`; if unavailable,
   use a YAML 1.2 parser and explicitly inspect the parsed `on.push.branches`,
   `paths`, and `workflow_dispatch` structure. Then run both acceptance gates,
   `bun run typecheck` and `bun run test:api`, not just typecheck.

One nuance that is already reasonable: the workflow comment should list the
API workflow's exact required scopes (Workers Scripts:Edit + D1:Edit +
Account:Read), while the central secrets documentation may correctly record
Pages:Edit too because the same named secret is also consumed by
`deploy-web.yml`.

## Round 2

### Verdict: aligned; ready to implement

All Round 1 findings are resolved. The design now constrains manual dispatches
to the `production` ref, requires least-privilege GitHub permissions and exact
SHA-pinned CI setup, names the current Bun/Node/cache/install contracts, fixes
the `main`/DEV documentation contradiction, records the literal retained DEV
Workers Builds configuration separately from the disconnected PROD
integration, and specifies Actions-aware YAML validation plus both requested
test commands. The requested production sequence and fail-closed ordering are
unambiguous. No remaining design-level correctness, security, YAML, or docs
issue blocks implementation.
