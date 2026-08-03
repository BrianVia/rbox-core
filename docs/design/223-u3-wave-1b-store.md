# U3 Wave 1B — store seam implementation

Status: implementation note for designs 222 and normative 163 v12.

## Scope

Wave 1B adds two policy-free store seams and differential tests. Nothing is
reachable from production; JSON remains the only selected authority.

1. `store/open.ts` exports `ClaimedInode` and
   `adoptClaimedStateStore(file, expected, install)`. Creation and adoption use
   one private initializer body for schema, pragmas, installer, validation,
   cleanup, and handle construction.
2. `adapters/sqlite-state-save.ts` converts the existing whole-state
   `StateSavePacket` into a sealed global stage and a sealed transition stage,
   then calls `applyCasPacket` with the raw `OwnedLockCasToken`.
3. Differential tests apply identical packets to JSON and the adapter, then
   compare whole-state readback.

## Store adoption

The adopter opens the already-created path with `O_NOFOLLOW`, holds that
descriptor while checking a regular, zero-byte, mode-0600 file whose
`{dev,ino}` equals `expected`, and confirms the path still names that inode
before SQLite opens it. Only after that proof does it close the claim
descriptor and enter the shared initializer body.

The shared body owns caught-failure cleanup. Creation marks its inode owned only
after the exclusive create succeeds; adoption marks it owned only after the
descriptor/path proof succeeds. After SQLite opens and before its first write,
the body rechecks that the path still names the claimed inode. A refusal before
ownership never deletes the path. Caught cleanup removes the main and its three
SQLite sidecars only while the main path still names the owned inode, so it
cannot delete a replacement. Process death remains outside caught cleanup.

`ClaimedInode` is `{ dev: number; ino: number }`, matching the state-plane's
existing physical identity types and the control-record representation planned
by design 222.

## SQLite save adapter

The stage directory is the store file's parent. The active store is already
specified at `.rbox/state/state.db`; keeping id-scoped sealed artifacts in that
owned state directory requires no new path policy from lane 1A.

The adapter takes one read snapshot, derives the CAS expectation from its token,
and:

- when `packet.global` exists, strips `gitRepos`, seals its files/header as a
  BASE generation, and binds every transition to that exact stage;
- always seals a transition stage from `packet.repos`, preserving each complete
  record, expected generation, and BASE proof;
- calls `applyCasPacket`, which owns adopted/refused sealed-artifact cleanup;
- discards any still-open builder and deletes sealed inputs if construction
  fails or CAS returns `busy`/`unsupported`, because no returned result exposes
  those input refs for a retry.

The adapter returns raw `CasResult`; authority selection, JSON paths, migration,
write-fence policy, and whole-state result translation remain outside it.

## Clarification carried to integration

Design 222's four observations (`absent`, sole zero-byte create-ahead,
recorded-incomplete, exact-completed) are explicitly the return space of
`claimStagingMain`, a Wave 3A function. The same document explicitly gives
`adoptClaimedStateStore` a `StateStoreHandle` return. The adopter cannot classify
those four observations because it receives neither migration control nor a
completion tuple, and lane 1B is forbidden from adding migration policy.
Therefore this lane implements the adopter signature from design 222 and leaves
the four-way discriminated `StagingMainClaim` to lane 3A. Design 163 v12 does
not specify a conflicting adopter return type.

## Tests and budgets

- Adopter tests cover exact adoption, wrong identity, nonzero/mode/sidecar
  refusal without deletion, caught installer cleanup, replacement-inode
  preservation, and fresh-create non-regression.
- Differential tests cover global+repo packets, repo-only packets, accepted
  revision/nonce behavior, and raw rejection/retry behavior through the adapter.
- Production files target 300 nonblank lines, may enter 301–399 with this review
  note, and must remain below the 400-line/25-KiB hard limit.
