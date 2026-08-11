# Review 231 round 1 — folder configuration authority

**Reviewers:** independent adversarial architecture and implementation passes
**Verdict:** NOT ALIGNED
**Disposition:** revise; no implementation authority

## Blocking findings

1. The draft incorrectly let the best-effort binding registry participate in
   binding admission. A readable per-root binding plus catalog membership must
   admit; absent registry evidence heals. Only a present scope witness has the
   existing fail-closed escalation semantics.
2. Compatibility projection proposed whole-record `workspace.json` writes
   without the scope/workspace lock order, so it could erase a concurrent
   `scopeIntent`, generation, scope commit, or rebind.
3. Existing `init`/`track` flags had no exact catalog-override semantics.
4. Rejecting nested/physical-alias entries during migration would implicitly
   retire currently supported layouts.
5. No exact cutover trigger existed, and migration could detach a currently
   resolved pre-registry binding.
6. Multi-root compatibility projection had no convergence record or safe
   sequential-downgrade observation.
7. New unbound/detached health values conflicted with the closed machine JSON
   v1 contract.
8. Compare-before-rename cannot provide true CAS against an editor that does
   not share rbox's lock.
9. Missing/rebound roots do not contain enough evidence to reconstruct their
   prior effective options exactly.
10. Runtime resolution lacked typed admission/generation, export/adoption
    policy witnesses, and one owner for catalog+binding+desired classification.
11. Daemon startup happens before the ordinary operation boundary and the
    current hot reload intentionally copies only one safe field to preserve
    runtime E2EE context.

## Required remediation

- Make `FolderCatalog` independent from registry/autostart modules and add a
  read-only `FolderInventory` composition Module.
- Make upgrade cutover explicit; create config automatically only on a fresh
  first bind. Refuse an exact migration when unresolved legacy rows cannot
  supply their policy unless the user explicitly skips them.
- Add one identity-checked binding-record mutation Interface under the existing
  scope-transition → workspace lock order; projection patches only safe fields
  after re-read.
- Preserve existing nested/alias layouts. New setup may warn/refuse overlaps,
  but migration/parser cannot make old bindings inoperable.
- Define bind-flag override behavior for create, join, same-workspace retrack,
  and rebind.
- Add per-root projection generation plus an idempotent all-root convergence
  operation/status; catalog wins after candidate re-upgrade.
- Keep machine JSON v1 untouched and give the catalog its own versioned JSON
  output.
- Narrow editor-race promises to atomic bytes plus best-effort stale-edit
  detection.
- Split delivery: dormant codecs/state machine first, binding mutation and
  inventory prerequisites second, atomic activation only after all consumers
  can switch together.

## Test execution

One reviewer ran focused registry/status/track/scope suites. This sandbox could
not supply the shared lock identity, so lock-owning cases stopped at the
existing lock gate. That baseline is not attributed to the design diff, but it
demonstrates why registry write success cannot become admission authority.
