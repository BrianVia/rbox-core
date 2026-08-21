# 283 resolution — no re-genesis mechanism; the four renames land plainly

Founder step-out re-ruling, 2026-08-21. This supersedes the same-day re-genesis
ruling and every ruling recorded in design 283 §13.

## What was decided

**No state.db migration or re-genesis mechanism is built.**

Design 283 (`PR #805`, closed, branch `design/283-state-regenesis` preserved)
took the re-genesis option through twelve adversarial review rounds and reached
ALIGNED. It is kept as a **negative result**, not a plan: it is the evidence for
why the mechanism is not worth building, and anyone who proposes rebuilding
state.db at open should read it first.

What that design proved, in order:

1. A store-opaque rebuild is impossible — everything being discarded is bound to
   the old lineage via a `lineageHash` that cannot be inverted from disk.
2. Riding `resetSyncState` works, but requires retaining a per-generation access
   port to the predecessor schema, forever, one per schema generation.
3. Every attempt to carry the resurrection guard (`removed_key`) across the
   rebuild failed — on candidate-DB size caps, then on journal crash-atomicity.
4. Deriving what to protect instead of carrying it also failed, because **the
   client cannot enumerate its own repositories completely**: `discoverGitRepos`
   prunes ignored subtrees and converts `readdir` failures into an empty result.
5. The only safe remaining posture was a **permanent** publication quiesce on
   every rebuilt device, released one repository at a time by explicit user
   confirmation.

**The re-ruling:** externals start fresh on 2.0, so only the three founder
machines hold v1 stores. A permanent quiesce plus a recurring port tax is the
wrong layer for a population of three. The renames land plainly, old stores keep
refusing, and the three machines cross over by hand, once.

## What shipped instead

- The four renames land directly in the DDL (`docs/wire-rename-candidates.md`).
  `STATE_STORE_DDL_FINGERPRINT` is now
  `94b519282f6efaed3c51b96e0bf0ca6b998922f149a0600501eedc0cb2224695`.
- `validate-open.ts` **keeps refusing** an old-fingerprint store. Its message
  now names the remedy, and `doctor` reports it as `state-from-other-version`
  with the same fresh-start chain it already prints for `authority-corrupt`.
- No version constant moved. `STATE_STORE_SCHEMA_VERSION` and
  `STATE_STORE_SQLITE_USER_VERSION` stay at 1, deliberately — see
  `docs/wire-rename-candidates.md` for why bumping either would make the
  remedy-bearing refusal unreachable.

---

## Founder-fleet crossover playbook

One-time, per machine, for the three machines holding v1 stores. This is an
operational procedure, not a code path — nothing in rbox automates it.

### Correction to the ruling's sketch — read this first

The re-ruling described the move as "move `state.db*` aside". **That is not
sufficient and would leave the workspace hard-refusing.** Verified against the
code:

- the authority marker is `<root>/.rbox/state.json`; the database is
  `<root>/.rbox/state/state.db`;
- `observeStateAuthority` (`state-plane/authority-bootstrap.ts`) classifies the
  workspace from **the marker alone** — marker present means `sqlite-store`;
- so a workspace whose `state.db` is gone but whose marker remains resolves to
  `sqlite-store` and then raises `StateAuthorityCorruptError`: *"says this
  workspace uses the new state format, but its state database is missing or does
  not match … rbox has changed nothing and will not try to repair this
  automatically."*

Moving only the database therefore converts a legible "records are from another
version" refusal into a self-inflicted authority-corrupt workspace. **The marker
must move with it.**

Keep `<root>/.rbox/config.json` — it holds the workspace binding. Moving the
whole `.rbox` folder aside works too, but then the machine has to be re-linked;
there is no reason to pay that here.

### Per machine

Run each step from inside the workspace and do not proceed on a surprise.

**1. Confirm there is nothing unpushed.**

```sh
rbox status --git
```

Everything must be synced and pushed. Any pending, deferred, held, or conflicted
repository is resolved **before** continuing — the old store is the only record
of that work's bookkeeping, and it is about to be set aside.

**2. Stop the daemon.**

```sh
rbox stop
```

**3. Move the marker and the store aside — never open the old database.**

```sh
ts=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/rbox-v1-state/"$ts"
mv .rbox/state.json ~/rbox-v1-state/"$ts"/
mv .rbox/state    ~/rbox-v1-state/"$ts"/
```

**Copy rule: never open the old `state.db` with any SQLite tool, including
read-only.** Darwin's system SQLite has persist-WAL on; a first read creates
`-wal`/`-shm` sidecars and never cleans them up, which mutates the very artifact
being preserved as evidence. If it has to be inspected, copy it elsewhere first
and open the copy.

`.rbox/config.json` stays. `.rbox/state/` includes `encrypt-cache.json`; moving
it aside costs one full re-encrypt on the next push. That is CPU only — encryption
is convergent, so unchanged files produce the same addresses, the server reports
them present, and no file bytes upload. To skip that cost, copy
`encrypt-cache.json` back into a fresh `.rbox/state/` after step 3.

**4. Start.**

```sh
rbox start
```

Absent authority is genesis's ordinary path (design 266), so a fresh v2-DDL
store is minted against the same stream from the preserved config.

**5. Verify.**

```sh
rbox status --git
```

Expect a full local re-baseline: one scan, a pull that adopts the server's
state, and a push that is a no-op or close to it for content already on the
server. Repositories already known to the server follow normally.

**Do not delete the preserved directory** until all three machines are across
and have been through at least one clean sync each.

### Order

Do one machine, verify it, then the next. Do not run the crossover on two
machines concurrently — a device mid-crossover is publishing a re-baselined view,
and staging them keeps any surprise attributable to one machine.
