# 91 - Head authority: fail-closed DO sequencer + explicit recovery

Status: Design draft 2026-07-09, from the Mac/FM commit-fork incident. Full-stack
scope: server DO sequencer hardening plus the explicit `rbox recover` client
command. Non-breaking: the DO's external commit/latest/commits contract is
unchanged; existing clients keep working and surface `repair_required` as a loud
sync failure instead of allowing a silent fork.

Simplification note (2026-07-09): the automatic D1 head backstop was cut. The
fork is prevented by fail-closed bootstrap alone; `rbox recover` and explicit
operator repair handle the rare DO-storage-loss case. Simplicity is the
correctness argument: the no-regress invariant is now true by inspection because
automatic bootstrap never reads an external source to set the head.

Origin: 2026-07-09 a per-workspace DO sequencer handed out sequence 475 to two
devices about 6 minutes apart; the losing device, with its pinned 475 orphaned,
halted until manually re-baselined.

## 1. Incident and evidence

- 23:54:44 device MAC commits, server returns `published sequence 475`; MAC pins
  `{commitSeq:475, hash:mac475}`.
- 23:54:44.755 MAC's next verify reports `head rolled back below the pinned
  sequence`; the head MAC observes is now below 475.
- 00:00:37 device FM commits and also gets `published sequence 475`, with a
  different hash; 00:11:32 FM publishes 476; server head then advances cleanly
  via FM.
- MAC stays halted because 476's parent is not `mac475`.

The steady-state DO sequencer is correct: it checks and advances `head` inside a
synchronous `transactionSync` with no await inside. The fork required the
authoritative DO `head` to become absent/regressed, then the old bootstrap path
reseeded from a lagging best-effort D1 mirror and re-issued an already-used
sequence.

## 2. Design - DO storage is the sole automatic head authority

### 2.1 Invariants

- **I1 - DO storage is the only automatic head authority.** Sequencing,
  `/latest`, `/commits`, roots, prune, and automatic bootstrap use DO storage
  only. No external source is read in the automatic path to set the head. The
  only exception is explicit operator repair, which may consult the best-effort
  D1 commits mirror under platform authentication and operator intent.
- **I2 - the head never regresses.** A monotone `headWatermark` records the
  highest sequence ever acked by this DO storage. A commit must satisfy both
  `parent === head.sequence` and `commitSeq === headWatermark + 1`.
- **I3 - the head carries its hash.** Head is `{sequence, commitHash}`, allowing
  same-sequence equivocation detection. A retry with the same hash is an ordinary
  conflict; a different hash at an already-acked sequence emits
  `same_sequence_different_hash`.
- **I4 - fail closed, never guess.** If `head` is absent but DO storage contains
  evidence of prior life, the workspace returns `repair_required` for reads and
  writes. A refusing workspace is recoverable; a guessed head can fork.
- **I5 - bodies are separate from authority.** Immutable commit bodies live at
  `seq:<n>` and may be pruned below the head. Reconstructing or mirroring a body
  never sets the head automatically.

### 2.2 Sequencer

Inside the existing synchronous transaction:

```text
head = storage.get("head")              // {sequence, commitHash}
watermark = storage.get("headWatermark") ?? head.sequence
if (parent !== head.sequence) conflict
if (commitSeq !== watermark + 1) conflict
next = { sequence: head.sequence + 1, commitHash: commit.commitHash }
storage.put("head", next)
storage.put("headWatermark", next.sequence)
storage.put(`seq:${next.sequence}`, storedCommit)
```

The transaction has no awaits. The output gate ensures the ack is not delivered
before these writes are durable.

### 2.3 Bootstrap / cold start

`ensureBootstrap` stays request-scoped single-flight because it needs the
workspace/project identity from the request. `doBootstrap` is DO-storage-only:

- `head` present as `{sequence, commitHash}`: use it and ensure
  `headWatermark >= head.sequence`.
- `head` present as a numeric legacy value: convert it to
  `{sequence, commitHash}` using `hashForSeq(seq)`. `seq:<head>` is retained
  because prune caps at `head - 1`; if `seq > 0` and the hash cannot be resolved,
  return `repair_required`.
- `head` absent with evidence of prior life: return `repair_required` and emit
  `bootstrap_head_missing`. Evidence is DO storage only:
  `headWatermark !== undefined`, `pruneFloor > 0`, or any retained `seq:*` key.
- `head` absent with no evidence: initialize genesis as
  `{sequence: 0, commitHash: GENESIS_HASH}` and `headWatermark = 0`.

There are no D1 reads in this automatic path.

### 2.4 Explicit repair

`/repair` is platform-authenticated using constant-time comparison and is the
only place a lagging external source may be consulted. It reconstructs a safe
head under explicit operator intent:

- `reconstructedSeq` is the max of the highest retained DO `seq:*` key and the
  highest sequence in the best-effort D1 `commits` mirror.
- `target = max(reconstructedSeq, headWatermark)`.
- `commitHash` is resolved from `hashForSeq(target)` or from the mirror row at
  `target`; `target = 0` uses `GENESIS_HASH`.
- If the hash cannot be resolved, repair refuses with `repair_unresolvable`.

Repair must never leave `head.sequence < headWatermark`. Worst case, if DO
storage is totally lost and the mirror is one commit behind, explicit repair sets
a safe ancestor and the client re-pushes. That is acceptable only under operator
intent and is not part of automatic bootstrap.

### 2.5 D1 commits mirror

The `commits` table remains best-effort and advisory for versions, GC support,
analytics, and explicit repair. It is not a head authority. Commit success no
longer depends on a second synchronous head write.

### 2.6 Telemetry

Emit on `bootstrap_head_missing`, `head_missing_with_retained_seq`,
`same_sequence_different_hash`, `repair_required_served`, and `repair_invoked`.
These turn storage-loss and equivocation cases into visible events.

## 3. Client - `rbox recover`

The server fix prevents new forks. The client recovery command is explicit,
user-invoked re-baselining: reset the local pin, foreground-verify the server
chain, reconcile local files via the existing keep-both path, and re-push local
diffs. Automatic benign-fork detection is deferred because it needs a richer
local pin/ancestor model.

## 4. Non-goals

- Changing the linear-chain model to a DAG or CRDT.
- Solving dev/prod namespace confusion.
- Per-single-workspace write-throughput scaling.
- Automatic recovery from total DO storage loss without explicit repair.

## 5. Compatibility

- Server endpoints are unchanged. `repair_required` is a distinct error current
  clients surface as sync failure, which is safer than a silent fork.
- Existing workspaces with stored numeric heads migrate on first access by
  resolving the retained `seq:<head>` commit hash and seeding the watermark.
- Client upgrade is independent. Old clients remain safe; new clients get
  `rbox recover`.

## 6. Acceptance gates

1. Incident regression: missing head plus DO evidence returns `repair_required`
   and refuses a duplicate parent-474 commit instead of accepting another 475.
2. Retained `seq:*` evidence: if `head` and `headWatermark` are wiped but
   `seq:474` remains, bootstrap returns `repair_required` without reading D1.
3. Equivocation: two commits at the same sequence with different hashes reject
   the second and emit `same_sequence_different_hash`; same-hash retry is not
   flagged.
4. Numeric-head migration: a bare-number `head` converts to
   `{sequence, commitHash}`, seeds `headWatermark`, and continues normally; if
   the hash cannot be resolved, it fails closed.
5. Repair state machine: genuinely new workspace initializes genesis; head
   absent with DO evidence returns `repair_required`; repair refuses when
   `target >= watermark` has no resolvable hash; repair succeeds at or above the
   watermark when the hash is resolvable.
6. `rbox recover`: a forked/halted client re-baselines onto the server head,
   reconciles via keep-both, re-pushes local diffs, and exits cleanly.
7. Compat: external endpoints remain unchanged; `bun test ./src`,
   `apps/api` workspace-sync vitest, and typecheck are green.

## 7. Rollout

1. Server hardening first: DO-only fail-closed bootstrap, `{sequence,commitHash}`
   head, watermark gate, equivocation telemetry, and explicit repair.
2. Client `rbox recover` ships with the next CLI release.
3. Monitor repair and bootstrap telemetry after rollout.

## 8. Risks

1. **Fail-closed false positives.** A legitimate workspace with missing head and
   retained DO evidence serves `repair_required` until repaired. This is safer
   than a silent fork.
2. **Mirror-lag repair.** Explicit repair can only use retained DO commits or the
   best-effort mirror. If the mirror is behind total DO loss, clients may need to
   re-push commits after repair.
3. **The storage-loss trigger recurs before rollout.** Until deployed, a repeat
   is possible; `rbox recover` makes recovery a supported command instead of
   keystore-file surgery.
