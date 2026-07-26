# Design 207 adversarial review — round 1

Date: 2026-07-26
Verdict: **NOT ALIGNED**

Reviewer scope: `docs/design/207-alchemy-iac-brownfield-evaluation.md`,
current rbox deployment/configuration sources, and Alchemy pinned at
`1b5d5a71feb0861f790bfd9fd3baaa9f3a163e27`.

## Blockers

### B1. Credential-level production isolation is infeasible in the shared account

The draft required a token whose scope could not mutate production resources.
Alchemy targets an account, not a resource allowlist, and the Worker/D1/Queue/R2
administration permissions needed by the evaluation are account-scoped. rbox
dev and production live in the same Cloudflare account. Naming conventions are
procedural protection, not a credential boundary.

Required change: run Phase A in a throwaway Cloudflare account. State explicitly
that Phase B cannot obtain credential-level dev/prod isolation while both share
an account; replace the false invariant with the exact human/workflow controls
that would be required.

### B2. "No secret material in Alchemy state" contradicts the state-store design

Alchemy's `Random` resource persists generated values. The state-store bearer
token and encryption key are Random resources; state encoding serializes the
underlying Redacted value. Remote records are encrypted, but bootstrap state
and the local credentials file still carry credential material.

Required change: prohibit newly representing rbox application/runtime secrets
in Alchemy state, explicitly except and threat-model Alchemy's own state-store
credentials, verify local file permissions, and define cleanup before Phase A.

### B3. Remote state is not safely disposable in rbox's shared account

The default state Worker/Secrets Store are account-level. The teardown path
force-deletes the Worker and deletes fixed-name secrets; its source says it is
intended for a throwaway account. The draft simultaneously called remote state
disposable and selected the shared account.

Required change: Phase A uses a throwaway account and includes its state-store
teardown there, or remote-state evaluation becomes a separately approved phase.
Never test teardown against rbox's shared account.

## Majors

### M1. Per-export Workers Cache parity is absent

rbox configures default export cache disabled and `CachedReleases` enabled.
Alchemy preserves ordinary JavaScript exports, but `WorkerProps.exports` is
internal to Durable Object/Workflow exports and the upload metadata has only
top-level cache. The provider cannot express rbox's per-export cache policy.

Required change: downgrade API/cache fit and make this an upstream blocker for
Phase B. A shadow upload must measure whether Alchemy removes the live setting.

### M2. Cold Queue consumer adoption violates the zero-create plan gate

`Queues.Consumer.read` only reads live Cloudflare state when persisted output
already supplies queue/account identifiers. On a fresh-state plan it returns
undefined, so the engine plans `create`, even though reconcile may later find
and reuse the consumer.

Required change: declare pinned Alchemy unable to satisfy Phase B's cold-plan
gate for existing consumers. Require an upstream fix/import mechanism or leave
consumer ownership outside Alchemy.

### M3. Planning is read-only only after state bootstrap/upgrade

The resource planner is side-effect-free, but initializing
`Cloudflare.state()` can bootstrap or upgrade the state-store Worker.

Required change: qualify the read-only claim and make bootstrap/upgrade an
independently reviewed mutation.

### M4. The state-loss test confused local credentials with remote state

Deleting local credentials tests reauthentication, not loss of the remote
Durable Object state. Remote stack-state loss triggers cold adoption and forced
reconciliation.

Required change: split local credential loss, remote state backup/restore,
isolated shadow stack-state deletion/cold adoption, encryption-key loss, and
duplicate-prevention tests. Never tear down shared remote state to test this.

### M5. Phase B had no executable sole-owner deployment path

Freezing Workers Builds while leaving migrations in the "existing Wrangler
command" leaves no owner reacting to `main` and serially performing migrations,
Alchemy apply, verification, and version upload.

Required change: either freeze API merges and production promotion for the
entire one-apply experiment, or specify an exact temporary serialized workflow.

## Minors

### m1. A retain dry-run does not prove retention

Required change: apply desired-state removal to a disposable retained Phase-A
resource, verify the physical resource remains, re-adopt it, then explicitly
destroy it in a separately reviewed cleanup.

### m2. "Snapshot/backup" was not a stack-level recovery contract

D1, R2, Queue backlog, Durable Object storage, Worker versions, and live config
have distinct recovery properties.

Required change: define per-resource recovery evidence and name anything that
cannot be snapshotted or restored.

## Confirmed correct

- The adoption routing table and forced-reconcile behavior.
- Name-based cold adoption for D1/R2/Queue.
- Default `destroy` removal policy and the need for explicit `retain()`.
- Worker adoption performs a real upload and metadata reconciliation.
- Tail consumers are unsupported at the pinned commit.
- Omitting `migrationsDir` keeps Alchemy from applying D1 migrations.
- No dual ownership and production exclusion are the correct strategy.
