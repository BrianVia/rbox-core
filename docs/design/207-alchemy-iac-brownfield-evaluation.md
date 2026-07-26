# Design 207: Alchemy IaC brownfield evaluation

Status: **PROPOSAL v3 / ALIGNED, NOT ACCEPTED — design only, no implementation
authorized (2026-07-26).** Round 1
(`docs/design/notes/207/REVIEW-207-R1.md`) returned NOT ALIGNED with three
blockers, five majors, and two minors; v2 folded all ten. Round 2
(`docs/design/notes/207/REVIEW-207-R2.md`) returned ALIGNED with one
non-blocking bootstrap-cleanup precision item; v3 folds it. This proposal
evaluates Alchemy at pinned upstream commit
[`1b5d5a7`](https://github.com/alchemy-run/alchemy/commit/1b5d5a71feb0861f790bfd9fd3baaa9f3a163e27),
package `alchemy@2.0.0-beta.64`. It does not authorize installing Alchemy,
changing a Cloudflare resource, disconnecting a build integration, or changing
the dev-first production-promotion contract in `docs/DEPLOYMENTS.md`.

## 1. Problem

rbox's Cloudflare application infrastructure is already substantially
declarative:

- `apps/api/wrangler.jsonc` defines the dev and production Workers, D1
  databases, R2 buckets, Durable Object binding and migration tag, Analytics
  Engine datasets, observability, Workers Cache, cron, Queues and DLQs, email
  binding, rate-limit bindings, vars, and the production custom domain.
- `apps/api/tail/wrangler.jsonc` defines the dev and production Tail Workers.
- `.github/workflows/deploy-api.yml` owns the test-gated production migration,
  deploy, and version-upload sequence.
- Cloudflare Workers Builds owns the dev deploy from `main`; Cloudflare Pages'
  Git integration owns the dashboard deploy. Those two integrations are
  founder-managed dashboard state recorded in `docs/DEPLOYMENTS.md`.
- Stripe and Clerk configuration remain external service state. Secrets remain
  in Cloudflare/GitHub, not git.

What rbox does not have is one typed resource graph and state store covering the
relationships among those resources. The question is whether
[Alchemy](https://github.com/alchemy-run/alchemy), an
Infrastructure-as-Effects framework, could improve that situation without
recreating production data, replacing stable resource identities, weakening
the deploy gates, or letting two deploy systems race over the same resource.

The decision is not "IaC or no IaC." Wrangler is already the declarative owner
of most API configuration. The decision is whether Alchemy's typed graph,
brownfield adoption, shared state, and stage composition are worth replacing
some or all of the existing Wrangler deployment plane.

## 2. Upstream facts pinned by this evaluation

The following claims are verified against the pinned commit, not assumed from
marketing copy:

1. Alchemy is currently pre-stable. Its README says it is alpha and to expect
   breaking changes; the inspected package is `2.0.0-beta.64`.
2. An async, non-Effect Worker can retain its existing module entrypoint.
   `Cloudflare.Worker` accepts `main`, `env`, compatibility settings, cron,
   domains/routes, observability, top-level cache, and ordinary JavaScript
   exports. Adopting Alchemy does not require rewriting
   `apps/api/src/worker.ts` into Effect. This is not full rbox parity:
   Alchemy cannot express the per-entrypoint cache policy that keeps the
   default export uncached while enabling cache on `CachedReleases`.
3. The Cloudflare providers cover the principal rbox API resources: Worker,
   D1, R2, Durable Objects, Queues/consumers, Pages projects, DNS/zones,
   Analytics Engine bindings, email bindings, rate-limit bindings, config, and
   secrets.
4. Alchemy has no built-in Stripe or Clerk provider.
5. The inspected Queue provider can cold-adopt a Queue by name, but its
   Consumer provider cannot cold-read an existing consumer without persisted
   output containing the queue/account ids. A fresh-state plan therefore
   reports an existing consumer as `create`, even though reconcile may later
   reuse it.
6. The inspected Worker provider does not declare Tail Worker consumers:
   `tailConsumers` is emitted as `undefined`. Alchemy can deploy the Tail Worker
   script as a Worker, but cannot currently express the parent API Worker's
   `tail_consumers` attachment with the inspected provider. rbox's attachment
   is currently commented out, so this is a future-parity blocker rather than
   a live-setting mismatch.
7. The inspected Pages project provider describes a direct-upload project.
   rbox intentionally uses a Pages Git integration because the former direct
   `wrangler pages deploy` path intermittently omitted changed assets. A Pages
   migration is therefore not a mechanical provider substitution.
8. `Cloudflare.state()` adds an Alchemy state-store Worker backed by a Durable
   Object and fixed-name state-store secrets. Alchemy state intentionally
   persists the generated bearer token and encryption key; remote records are
   encrypted, while a local credentials file also holds the bearer token. The
   upstream teardown implementation says it is intended for a throwaway
   account. This is additional account infrastructure and an additional
   credential path, not a free abstraction over existing Wrangler state.

These facts must be re-verified against the exact Alchemy version selected by
any future implementation. `@next` is not an acceptable unpinned dependency.

## 3. Can existing infrastructure be rebound?

### 3.1 Answer

**Yes, resource by resource, but "adopt" is a managed takeover, not a read-only
import.**

Alchemy's engine calls a provider's `read` operation when the stack has no
state for a declared resource:

| Provider `read` result | Adoption disabled | Adoption enabled |
|---|---|---|
| resource absent | create | create |
| existing, reported owned | silently adopt | silently adopt |
| existing, reported `Unowned` | fail `OwnedBySomeoneElse` | adopt |

At the pinned commit:

- D1 databases, R2 buckets, and Queues locate an existing resource by its exact
  physical name and return its live identifier. Their providers do not brand
  the cold-read result `Unowned`, so they are silently adopted by name.
- Existing Workers, Pages projects, zones, and DNS records have ownership
  gates and require an explicit `--adopt`/`adopt(true)` takeover when Alchemy
  cannot prove prior ownership.
- When a Wrangler-created Worker is adopted, its existing Durable Object class
  can be reused. On that first deploy, the declared binding name and
  `className` must match the live Worker. rbox's contract is
  `WORKSPACE_SYNC` → `WorkspaceSync`.

### 3.2 The first apply is a mutation

After the selected state backend is already bootstrapped and version-compatible,
an adoption resource plan is read-only. Initializing `Cloudflare.state()` can
itself bootstrap or upgrade the state-store Worker, so bootstrap/upgrade is a
separate reviewed mutation. An applied adoption is deliberately forced through
the provider's update/reconcile path. For the API Worker this means an upload
and ownership-tag write. For every adopted resource it means the provider
converges live mutable settings to the desired declaration.

Consequences:

- A partial Alchemy declaration is unsafe. Omitted bindings, routes, domains,
  subresources, build settings, or environment configuration may be removed or
  reset by reconciliation.
- Exact names prevent duplicate D1/R2/Queue resources, but exact names do not
  make a partial desired state safe.
- Adoption cannot be used as a metadata-only state import followed by an
  unrelated later deployment.
- A dry run proves what the current provider plans; it does not prove the
  provider has complete semantic parity with Wrangler.

### 3.3 Removal policy is load-bearing

Alchemy resources default to removal policy `destroy` unless a provider
overrides it. The Cloudflare Zone provider defaults to `retain`; the inspected
D1, R2, Queue, Worker, and Pages providers do not.

Every brownfield resource in an evaluation stack must therefore be wrapped in
an explicit `retain()` policy. This includes both data-bearing resources and
Workers/configuration resources. No adopted rbox resource may rely on the
framework default. `alchemy destroy`, resource removal from the stack, stack
renaming, and stage renaming must all be tested as dry runs before an adoption
apply is considered.

## 4. rbox coverage and gaps

| rbox surface | Alchemy fit | Brownfield disposition |
|---|---|---|
| API Worker entrypoint and named exports | partial | Async entrypoint can remain; per-export cache policy is not expressible |
| D1 dev/prod databases | strong | Reuse exact names/UUIDs; keep Wrangler migration ownership during evaluation |
| R2 dev/prod/release buckets | strong | Reuse exact names; explicitly retain; inventory public access, domains, CORS, and lifecycle first |
| Durable Object `WorkspaceSync` | strong but high-risk | Reuse only with exact binding/class match and zero replacement in plan |
| Queues and DLQs | strong | Reuse exact names; explicitly retain |
| Existing Queue consumers | blocked | Cold plan reports create; needs upstream read/import fix or stays outside Alchemy |
| Cron, observability, top-level cache, custom domain | strong | Must match live settings exhaustively |
| `CachedReleases` per-export cache | blocked | Provider has no equivalent; must not adopt API Worker until fixed |
| Analytics Engine, email, rate limits | supported bindings | Preserve binding names and namespace ids exactly |
| Worker secrets and vars | supported | Secret values stay out of git; credential migration needs a separate threat review |
| Tail Worker scripts | partial | Scripts can deploy; parent `tail_consumers` attachment is unsupported |
| Web Pages project | poor migration candidate | Keep the existing Pages Git integration out of the pilot |
| Workers Builds dev integration | not captured as resource ownership | Must not coexist with Alchemy ownership of the same dev Worker |
| Production GitHub deploy gates | replaceable workflow, not provider feature | Preserve tests-before-migrations-before-deploy and explicit `production` promotion |
| Stripe and Clerk | unsupported | Remain outside Alchemy |

Alchemy therefore cannot become the complete IaC source of truth for rbox at
the pinned version. It can potentially own the Cloudflare API resource graph,
while dashboard integrations and third-party services remain documented and
managed elsewhere.

## 5. Proposal

Run a **bounded evaluation**, not a production migration.

### Phase A — isolated shadow stack

Create an Alchemy stack in a **separate throwaway Cloudflare account** whose
physical resources are new, disposable, and unrouted. The rbox Cloudflare
account is out of scope: the required Workers/D1/R2/Queues permissions are
account-scoped and cannot form a credential boundary between rbox dev and
production resources.

- a shadow async Worker built from a minimal rbox-compatible entrypoint;
- an empty D1 database;
- an empty R2 bucket;
- a Queue, consumer, and DLQ;
- a disposable Durable Object class;
- representative Analytics Engine, rate-limit, cron, observability, and cache
  configuration;
- Cloudflare remote state under a dedicated Alchemy profile.

The throwaway account must not host or reference rbox's dev or production
D1/R2/Queue resources, `api.rbox.to`, `rbox-releases`, the Pages project, or
live secrets. Bootstrap/upgrade of its state store is reviewed independently
from the shadow resource plan. Its teardown runs only after the disposable
stack is gone and only in the throwaway account.
Its purpose is to validate provider behavior, state recovery, plan stability,
async bundling, and teardown/retention semantics against disposable resources.

Phase A produces an evidence report; it does not create a standing deployment
surface.

### Phase B — brownfield dev adoption experiment

Phase B is **blocked at the pinned Alchemy commit** by two known provider gaps:

1. the API Worker cannot preserve `CachedReleases`' per-export cache policy;
2. a fresh-state plan cannot recognize an existing Queue consumer and therefore
   cannot satisfy the no-create adoption gate.

Phase A success does not waive either blocker. Phase B is a separate
founder-gated design after Phase A and after upstream fixes or another
evidence-backed ownership boundary resolves both gaps. Before it can apply:

1. Export/inventory the complete live `rbox-dev-api` Worker settings and all
   referenced resource identifiers.
2. Produce a field-by-field Wrangler → Alchemy parity table, including every
   binding and Worker metadata field.
3. Declare exact physical names and explicit `retain()` on every adopted
   resource.
4. Keep D1 schema migration execution in the existing Wrangler command during
   the evaluation; Alchemy must not independently apply or reinterpret the
   production migration history.
5. Bootstrap/upgrade the selected state backend as its own reviewed mutation,
   then run the adoption dry-run from an empty stack/stage state. The
   brownfield portion of the plan must contain
   zero creates, replacements, or deletes for brownfield resources.
6. Resolve every unsupported or unexplained field. "The plan did not print it"
   is not evidence that the provider preserves it.
7. Choose exactly one deployment owner. Alchemy must not apply to
   `rbox-dev-api` while Cloudflare Workers Builds can also deploy that Worker.
   Disconnecting Workers Builds requires an explicit founder action and a
   recorded rollback procedure.
8. Freeze API merges and `main` → `production` promotion for the whole
   experiment. The one permitted sequence is: select and record an exact
   commit; run typecheck/API tests; apply only the dev D1 migrations with the
   existing Wrangler D1 command; run the reviewed Alchemy adoption apply; run
   deployed verification; then either roll back to Wrangler or finish the soak.
   Neither `wrangler deploy` nor `wrangler versions upload` runs while Alchemy
   is the Worker owner.

Only after those gates may one dev adoption apply occur. Production, the
production D1 database, production R2 data, `rbox-releases`, the Pages project,
DNS/zone ownership, and Stripe/Clerk are excluded.

### Phase C — decision

After a dev soak, choose one:

- **Reject Alchemy:** destroy only disposable Phase-A resources, clear no
  brownfield state until the live resources are confirmed retained, restore
  the sole Wrangler owner, and record the evidence.
- **Keep as an evaluation tool:** use Alchemy only for isolated future
  resources; do not dual-manage existing rbox resources.
- **Propose a production migration:** write a new design against a freshly
  pinned Alchemy release. Design 207 does not authorize this outcome.

## 6. Safety invariants

1. **No dual ownership.** At most one of Wrangler/Workers Builds and Alchemy may
   apply configuration to a physical Worker at a time.
2. **No implicit deletion.** Every brownfield resource has explicit
   `retain()`. No evaluation command uses `alchemy destroy` without a reviewed
   dry-run.
3. **Credential boundary is truthful.** Phase A runs in a throwaway account, so
   its account-scoped token cannot reach rbox. Phase B cannot obtain
   credential-level dev/prod isolation while both share the rbox account; a
   future Phase-B design must enumerate the account-scoped permissions and ask
   the founder to accept that residual explicitly. Naming conventions are not
   represented as a security boundary.
4. **No data migration.** Adoption must reuse the existing identifier; any plan
   to clone, replace, import, empty, or recreate a D1 database, R2 bucket, or
   Queue fails the evaluation.
5. **No migration race.** Exactly one system applies D1 migrations.
6. **No deployment-gate regression.** Any future Alchemy workflow retains
   typecheck/API-test gates before D1 mutation, deploy before version upload,
   serial production concurrency, and explicit `main` → `production`
   promotion.
7. **No Pages direct-upload regression.** The current Pages Git integration is
   unchanged by this evaluation.
8. **No rbox application secret enters Alchemy state.** Alchemy's own
   state-store bearer token and encryption key are explicit exceptions:
   generated values are persisted in encrypted remote state, and the bearer
   token is cached locally. Phase A threat-models those credentials, verifies
   local credential-file permissions and cleanup, and never introduces an
   rbox runtime/application secret.
9. **No unpinned pre-release.** The package and GitHub Action are pinned to a
   reviewed version/commit.
10. **Rollback precedes mutation.** The exact command, credential, and source
    commit that restore the Wrangler-owned dev Worker are exercised against a
    shadow Worker before brownfield adoption.

## 7. Acceptance gates

Phase A passes only if:

- two consecutive no-change plans are no-ops;
- state bootstrap/upgrade and the resource plan are captured as separate
  mutations;
- after state bootstrap hoists into the remote store, the bootstrap-local
  stack/state is verified deleted and the filesystem is checked for recoverable
  bearer-token or encryption-key residue beyond the documented profile
  credential file;
- removing the local Alchemy credential file tests re-login only and does not
  get misreported as remote-state recovery;
- shadow stack/stage state is exported or otherwise recoverably backed up
  before a state-loss exercise; if the pinned version has no supported,
  verified backup/restore path, the gap is recorded and remote-state recovery
  does not pass;
- clearing only the shadow stack/stage state produces the expected cold-adopt
  updates, creates no duplicate physical resources, and is followed by a
  verified state restore or reviewed re-adoption;
- encryption-key and state bearer-token loss behavior is documented and
  verified fail-closed in the throwaway account;
- an explicit resource change produces the expected bounded update;
- async Worker exports, Durable Object calls, Queue delivery/DLQ behavior,
  D1/R2 bindings, cron, rate-limit binding, observability, and cache are
  exercised in the deployed shadow stack;
- a disposable retained resource is removed from desired state in an applied
  plan, verified still present physically, re-adopted, and only then explicitly
  destroyed through a separately reviewed cleanup;
- plan/log output contains no credential value; remote state encryption and
  the expected local state-store credential file are inspected rather than
  denied;
- teardown removes only disposable resources explicitly marked for destroy.

Phase B may be proposed only if:

- the live-inventory parity table has no unknowns;
- `--adopt --dry-run` reports no create, replace, or delete for brownfield
  resources;
- the Durable Object plan proves reuse of the existing class/namespace;
- the per-resource recovery matrix in §8 is completed with tested evidence;
- Workers Builds is frozen or disconnected for the experiment;
- the dev Worker passes `bun run typecheck`, `bun run test:api`, its deployed
  smoke checks, and the relevant `bun run rig` scenario;
- a second plan is a no-op; and
- the founder explicitly authorizes the one live dev apply.

## 8. Rollback

Phase A rollback is ordinary destruction of disposable resources after a
reviewed plan, followed by the upstream state-store teardown in the throwaway
account and deletion of the dedicated local Alchemy profile/credentials. The
state store is never torn down in the rbox account.

Phase B rollback is not `alchemy destroy`. It is:

1. stop further Alchemy applies;
2. redeploy the recorded rbox commit through the known Wrangler dev command;
3. verify the Worker script, bindings, routes, cron, Queue consumers, Durable
   Object class, D1 UUID, and R2 bucket names;
4. restore the sole dev deployment integration only after verification; and
5. retain Alchemy state until a read-only audit proves clearing it cannot
   trigger or conceal later deletion.

Because an applied adoption writes ownership metadata and reconciles settings,
rollback evidence must include the live post-Wrangler configuration, not only a
successful `wrangler deploy` exit code.

There is no single "stack snapshot." A future Phase-B design must complete this
matrix before authorization:

| Surface | Required recovery evidence |
|---|---|
| Worker code/version | exact source commit, pre-adoption live settings export, and exercised Wrangler redeploy |
| Worker bindings/routes/cron/cache/observability | pre/post live configuration diff; explicit proof that every field is restorable |
| D1 | UUID and configuration inventory; provider must not replace/import/clone or mutate rows; separately verified database restore point where available |
| R2 | bucket identity and configuration export; object contents are not assumed to have a stack-level snapshot and must not be mutated |
| Queue/DLQ | ids and configuration export; backlog is not assumed portable or restorable |
| Durable Object | Worker/class/namespace identity and migration history; storage is not assumed to have a stack-level snapshot |
| Alchemy state | stack/stage backup/restore evidence, encryption-key custody, and a cold-adoption rehearsal in the throwaway account |

## 9. Non-goals

- Adopting or deploying production infrastructure.
- Replacing `docs/DEPLOYMENTS.md` with generated documentation.
- Moving Stripe, Clerk, Pages Git integration, or dashboard-only configuration
  into custom Alchemy providers.
- Rewriting the API Worker into Effect.
- Moving D1 migration ownership during the evaluation.
- Introducing PR preview environments.
- Using Alchemy's account-wide unsafe deletion/nuke capability.
- Treating a successful dry run as sufficient evidence for provider parity.

## 10. Decision requested

Approve or reject **Phase A only**. Acceptance of this design would authorize a
disposable shadow-stack implementation design/cycle. It would not authorize
Phase B, any brownfield apply, or any production change.
