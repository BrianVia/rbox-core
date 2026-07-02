# 53 — Incremental git packs (bundle chains: push cost O(history) → O(delta))

**Status:** draft — spec only, NOT scheduled (founder: stability first; build on measured trigger).
**Builds on:** design 02 (bundle-based capture/apply), §28 (git artifacts under E2EE — the
prior-art note that *named* this optimization), design 43 (nested-repo `gitRepos` sections,
`refScope`, the §7 carry matrix, per-repo defer/422/removal machinery), §06/§33 (retention →
mark → purge reachability GC).
**Non-goals:** any server/API/D1/Worker change; cross-repo or cross-worktree object dedup beyond
the recommendation in §4; any change to file sync; any change to the design-43 §7 failure/recovery
*semantics* (increments ride *inside* a section and must be invisible to that machinery).

---

## 1. Problem — bundles never dedup, so every git change re-ships all history

§28 and design 43 ship a repo's history as a **full `git bundle`** (`--all` for dir repos,
`refs/heads/<branch>` for pointer repos), convergent-encrypted and uploaded by `encSha`. Because
`git stash create` mints a fresh WIP commit and the bundle carries the whole object closure, the
**bundle bytes differ on every capture** — so bundles **never dedup** (stated in
`src/engine/git/capture.ts` header, `docs/design/28` "Bundle determinism / dedup", and
`docs/learnings.md:586`). Change detection (`gitIdentityKey`, `src/engine/git/identity.ts`)
correctly *skips* an unchanged repo, but the moment identity moves by **one commit** — or the index
churns, or dirty state shifts the WIP commit — `captureGitState` re-bundles and re-uploads the
**entire history**.

At the founder's scale this is the standing cost. `savvy-core` is ~762 commits / 246 tags / ~17 MB
`.git` (`docs/learnings.md`), and his `~/conductor/workspaces` layout carries **30+ Conductor
worktrees of that one repo** (design 43 §1). Design 43 §13 booked the honest cost — "each worktree
ships its branch's full history once … ~17 MB × N … Incremental packs stay the future fix" — and
§28's prior-art analysis of `git-remote-gcrypt` named the exact remedy:

> track the pushed object set, bundle only `--not` the already-uploaded refs, and keep an
> (encrypted) pack list in the GitSection — turning push cost from **O(history) into O(delta)**.
> Deferred until a measurement shows full-bundle re-upload is a real cost at our scale.

This document makes that fix decision-complete. It does **not** schedule it (§6).

## 2. Delta mechanism — a bundle chain carried inside the GitSection

### 2.1 The increment

`git bundle create` accepts negative revisions, so a delta bundle is:

```
git -C <repoDir> bundle create <inc.bundle>  ^<basis-tip-1> ^<basis-tip-2> …  <new-refs…> <pins…>
```

A bundle built with `^basis` records those basis commits as **prerequisites** in its header and
ships only the objects reachable from the new tips but *not* from the basis. This composes cleanly
with the design-43 §5 pinning discipline: the enumerated `refs/rbox-wip/<captureId>/*` scratch pins
(`src/engine/git/pins.ts` `createScratchPins`/`collectPinShas`) and the dir-repo `refs/stash`
entry are still passed as **positive** revs, so a new detached-HEAD sha, a new WIP/stash commit, or
a new pseudo-ref commit (`MERGE_HEAD`, rebase state) all ride the increment — negated only against
the *previously captured* tips, never against the pins.

### 2.2 The basis is the base section — no new persistent basis state

The sender already has, in `state.lastSyncedManifest.gitRepos[rel]` (read today by
`planGitSections` as `const base = …`, `src/cli/sync-git.ts`), the section it last synced. That
section's `refs` **are** the basis tips, and its bundle chain **is** the existing chain. So:

- **basis tips** = `Object.values(base[rel].refs)` — for a pointer/scoped section this is exactly
  the one current-branch sha; for a dir/all section, every branch+tag sha.
- **existing chain** = `[...(base[rel].packChain ?? []), base[rel].bundle]` (base first, newest
  last).

The next increment is `^basis-tips <current tips + pins>`, and the section published this cycle is
`{ …base fields…, packChain: existingChain, bundle: <new increment> }`. **No new local state.** The
basis for a *cross-machine* extension is derivable the same way: machine B, having *applied* A's
chained section, holds that section as its base — so B can extend the chain (append an increment
negated against `base.refs`) without ever having captured the repo. This reuses design 43's
"the base section is the single source of truth" invariant and touches none of the §7 state maps.

> Convergent-encryption subtlety, resolved: an increment's plaintext bytes still vary per capture
> (fresh WIP commit), so **increments don't dedup either** — but each increment is O(delta) bytes,
> not O(history), which is the entire win. Convergent encryption is unchanged; we are shrinking the
> plaintext, not deduping it.

### 2.3 Schema — additive field, conditional bump to `manifestSchema: 3`

Design 43 chose a **clean break** to schema 2 (`src/engine/types.ts`, `KNOWN_MANIFEST_SCHEMA = 2`)
because it was *deleting* the legacy `git` field. This change is **purely additive** — a full-bundle
section (no `packChain`) stays byte-for-byte a valid design-43 section, so **existing data needs no
migration**. `GitSection` gains one optional field:

```ts
interface GitSection {
  …                                   // unchanged: bundleSha/EncSha/CipherSize = the NEWEST link
  /** design 53: ordered ANCESTOR bundle blobs (base first, previous-increment last) that must be
   *  fetched into the staging store BEFORE this section's own bundle. Absent = self-contained full
   *  bundle (today's design-02/§28/§43 shape). Present = this section's `bundle*` fields are an
   *  INCREMENT whose prerequisites are satisfied by the last link's tips. */
  packChain?: GitArtifactRef[];
}
```

`validateGitSection` (`src/engine/manifest-validate.ts:147`) gains: each `packChain` entry passes
`validArtifactRef`; the chain length is bounded (`MAX_PACK_CHAIN`, see §3); and — the load-bearing
rule — **a section with a non-empty `packChain` requires `manifestSchema >= 3`**.

We do **not** flag-day the whole fleet to schema 3. Following §2's own precedent
(`manifestSchema: 2` is set *only when* `gitRepos` is present), the pusher sets `manifestSchema = 3`
**only when some section actually carries a `packChain`**; a workspace whose repos all recompact to
full bundles stays schema 2. This preserves design 43's hard-won invariant — *every future schema
break fails loudly* — because a pre-increment client, gated by `schema > KNOWN_MANIFEST_SCHEMA`
("upgrade rbox"), **refuses** a chain-bearing manifest instead of silently mishandling it. There is
no repeat of the §2 "silent-strip" window: that window existed only for the pre-schema-gate legacy
`git` field; the gate closes it for all future breaks, this one included.

> Why the field and not just a per-machine convention: the **receiver** cannot reconstruct the
> chain locally (it has no record of what basis the sender negated against). The chain *must* travel
> in the manifest, and the manifest is E2EE — so the server still sees only opaque blobs and their
> count/sizes (§28 leakage model, unchanged; §8).

### 2.4 Apply — fetch the chain in order into the staging store, verify each link

The design-43 apply (`src/engine/git/apply.ts` `applyGitState`) already fetches the bundle into an
apply-unique `refs/rbox-incoming/<id>/*` namespace under quarantine + `git bundle verify` + fsck +
rollback, with **decrypt-before-mutate** (all artifacts fetched, decrypted, and verified *before*
any gitdir mutation, §28 codex M4). The chain extends this without weakening it:

1. In the decrypt-before-mutate phase, fetch **every** `packChain[i]` blob + this section's own
   bundle via `getGitArtifact` (`src/engine/git/shared.ts`) into temp files. Any missing/corrupt
   link throws here → `{applied:false}`, target untouched (existing behavior; §5).
2. Import the links **in order** (base → … → tip) with the existing
   `git fetch --no-tags <link> 'refs/*:<incomingNs>/*'` into the *same* incoming namespace, so each
   link's objects land in the target's object store before the next link (which needs them as
   prerequisites) is fetched.
3. **`git bundle verify` semantics for increments — the reasoning that governs step 2 ordering.** A
   bundle with prerequisites reports them and **errors if the objects it requires are absent from
   the repo you verify against**. So the design-43 gate — `git bundle verify <bundle>` against the
   *pre-existing* target before mutating (`apply.ts:188`) — is only valid for a **self-contained**
   bundle. For a chain we verify **per link, after its ancestors are fetched**: the base link (no
   prerequisites) verifies standalone; `packChain[1]`'s prerequisites are the base tips, now present
   in `<incomingNs>`, so it verifies; and so on. Verifying the tip increment against the bare
   pre-existing repo — as design 43 does today — would **fail** (its prerequisites live only in the
   earlier links), which is exactly the failure mode §5 must never let escape as data loss.
   Practical shape: for chained sections the whole chain is fetched+verified into the incoming
   namespace *first*, and only then does the existing publish/HEAD/index/fsck/rollback sequence run
   unchanged. A verify or fetch failure at any link → `{applied:false}`, defer (§5), nothing
   published.

The publish/HEAD/index/op-state/fsck/rollback tail is **entirely unchanged**: once the chain's
objects are all in the store, publishing `section.refs` and restoring index/op-state is identical to
the full-bundle path. Increments change *how objects arrive*, never *what state is published*.

## 3. Compaction — chains can't grow forever

A chain that only ever appends becomes slower to apply and pins more blobs into retention. The
sender **recompacts** — emits a fresh full bundle with `packChain` cleared — on a **capture-side,
receiver-agnostic** trigger (the receiver applies whatever it's handed; recompaction needs no
coordination):

- **Length bound:** `packChain.length + 1 >= MAX_PACK_CHAIN` (proposed default **20**; also the
  validation ceiling in §2.3).
- **Byte bound (gcrypt's heuristic, made concrete):** `sum(cipherSize of all links) >=
  base-link cipherSize`. The base link's `cipherSize` is a cheap proxy for full-bundle size, and it
  is already carried in `packChain[0]`. Once the increments in aggregate cost as much as the base,
  the chain has lost its advantage → collapse to one full bundle. (`git-remote-gcrypt`'s README warns
  the unbounded-append model "can easily get to the point that continued usage is impractical";
  this bound is what prevents that.)

Recompaction is *just a full capture*: `captureGitState` with `packChain` omitted — i.e. today's
exact behavior. So recompaction is also the **universal fallback** (§5): any doubt → full bundle.

**GC of superseded links — nothing new; retention does it.** Every link is manifest-referenced, so
the §28 correctness rule extends verbatim: `e2ee-remote.ts` `commit()` (the `addGit` loop at
`e2ee-remote.ts:367`) must add **every `packChain[i].encSha`** to `blobRefs`, not just
`bundleEncSha` — otherwise GC condemns a live chain link and every apply of that section breaks
(the load-bearing point from §28 step 3). `sync-git.ts`'s `sectionEncShas` helper must likewise
include the chain (§5). Given that, superseded links age out **for free**: when a section
recompacts, the new head commit no longer references the old links, but older *retained* commits
still do — so the links survive exactly until those commits fall outside the owning account's
retention window (Free 7 / Solo 30 / Pro 90 days, §06 M7b), at which point the existing
retention → mark → purge sweep (§06/§33) reclaims them. **No new GC path, no server change.** The
one interaction to keep in view: a long chain across many retained commits keeps more blobs
reachable within the window than a full-bundle workspace would — bounded by `MAX_PACK_CHAIN` and the
byte trigger, and quantified against retention in testing (§6).

## 4. The multi-worktree question — increments only; do NOT build shared basis (recommendation)

The founder's actual layout: 30 worktrees of one repo, each captured **standalone** (design 43 §5 —
because the main clone lives outside the tree and Conductor may delete it), each carrying an
independent full history today.

**What increments alone fix, quantified.** Steady state drops from
`30 worktrees × 17 MB × (every capture cycle a worktree's identity moves)` to
`30 × 17 MB once` **+** `30 × O(delta) per cycle`. The recurring term — worktrees re-shipping full
history every time an agent makes a commit or churns the index — is the term that was actually
loading the machine, and increments **kill it**. Each worktree's **first** capture, and any
**recompaction** (§3), still ships that worktree's full branch history once (~17 MB); that cost is
**non-recurring** and already skipped-when-unchanged by the identity carry (`gitIdentityKey`), so
increments leave a bounded one-time `30 × 17 MB ≈ 480 MB` and remove the unbounded recurring bleed.

**What increments do NOT fix.** A *fresh* worktree's first capture is still O(history). The only
thing that fixes *that* is a **per-origin shared basis**: one shared base pack of the origin's common
history, with each worktree shipping only its delta from it.

**Recommendation: keep per-repo independence + increments; do not build shared basis (v1, and
likely ever).** Shared basis reintroduces precisely the coupling design 43 spent six review rounds
removing. It makes worktree section B's applicability *depend* on a shared-base blob S being present
and applied first — a cross-section reachability + ordering dependency that every part of the §7
matrix (per-repo defer, per-repo 422 recapture via `gitForceForMissingBlobs`, per-repo removal
memory, per-repo base advance) assumes does **not** exist; §8's "union blobRefs, GC roots each
encSha exactly once" and §2's clean per-section independence would all have to be reopened. Worse,
there is **no sound origin key to group worktrees by**: design 43 captures them standalone *by
contract* precisely because the main clone may be gone, so "these N sections share an origin" is not
reliably knowable. And the "free" convergent version doesn't exist — convergent sharing needs
byte-identical base bundles across worktrees, which capture (fresh WIP commits, per-capture pins)
never produces; you'd need a deterministic canonical base-pack builder, a whole subsystem. Against
the founder's explicit "stability first," importing that coupling to shave a **non-recurring**
480 MB is a bad trade. **Increments deliver the recurring win at zero cross-section coupling.**
Shared basis is recorded here as a deferred §53.x, to be revisited *only* if measurement (§6) ever
shows first-capture / recompaction volume — not steady-state re-upload — dominating git cost.

## 5. Failure / recovery matrix — every path degrades to a full bundle

The increment layer is an **optimization shell around a correct core**. The core is design 43's
full-bundle capture/apply, which is already proven; increments are an opt-in fast path that **any**
error escapes back into the full path. Concretely:

| Failure | Detection | Degradation |
|---|---|---|
| **Basis unavailable at capture** (no base section, base unreadable, `bundle create ^basis` errors) | capture-side, before upload | emit a **full `--all`/scoped bundle**, `packChain` omitted — today's `captureGitState` default branch. Never a failed push. |
| **Missing chain-link blob, server-side (sender 422)** | `commit()` returns `unsatisfiedBlobs`; `sectionEncShas` (extended to include `packChain`) intersects the missing set → `gitForceForMissingBlobs` adds the repo to `force` | forced repos skip the carry fast-path (`planGitSections`) **and force-recapture emits FULL** (chain reset) — never another increment negated against the same missing basis. Reuses design 43 §6/M5 verbatim. |
| **Missing / corrupt link on receiver apply** (GC'd, never uploaded, bit-rot) | `getGitArtifact` throws in decrypt-before-mutate, or a per-link `git bundle verify` fails (§2.4) | `applyGitState` → `{applied:false}` with the target **untouched**; `applyGitSections` records `gitPendingRemote[rel]` and defers (design 43 §7 [v5]). The stall resolves when the sender recompacts to full (below). |
| **Sender re-carries a chain the receiver can't apply** | receiver stays pending; identity unchanged, so `planGitSections` would re-carry the same broken section | the receiver's persistent defer is the signal; the operator-visible standoff (`rbox status`, design 45) is the same non-destructive stall design 43 §7 already ships. Deterministic heal: a recompaction at the sender (§3, or forced by any 422) replaces the chain with a self-contained full bundle the receiver **can** apply. |
| **Divergent history (force-push / rebase in a worktree)** | identity moves → normal recapture; `bundle create ^oldbasis <rewritten-tips>` ships the rewritten objects (prerequisites = old basis, still present in the chain) | apply verifies (old basis objects present) and publishes the rewritten tip via the existing ref-publish rules; orphaned old objects are harmless. If the rewrite shares little with basis the increment grows toward full → the §3 byte trigger recompacts. No special case. |
| **Busy / defer / needsResolution / removal** (design 43 §7 carry matrix) | unchanged | a carried section is **reused verbatim** — its `packChain` rides along and **does not grow** (carry ≠ capture). Removal drops the whole section (chain included); retention ages the links out (§3). The chain is invisible to every one of these paths. |

**Invariant (normative):** *no section is ever un-applyable in principle.* A full bundle always
applies; every increment path that cannot complete falls back to (or is healed by) a full bundle.
The increment layer must never become a new correctness dependency — it may only make a correct
transfer cheaper.

## 6. Trigger to build, staged rollout, test plan

**Build trigger — measured steady-state re-upload volume, not clone-time spikes.** Design 35
(client phase metrics) already instruments the daemon; extend it to attribute **git bytes uploaded
per cycle to *captured* (not *carried*) sections**, and compute the **re-upload amplification** =
`bytes shipped ÷ bytes of genuinely-new objects` (new-object bytes are cheaply estimable as the
`bundle create ^lastTips` size — measurable *without* shipping it). Build when, over a representative
week of the founder's real `~/conductor/workspaces` daemon:

- sustained median amplification **> ~10×** (i.e. we ship an order of magnitude more than the delta), **or**
- absolute git re-upload from unchanged/near-unchanged histories **> a few GB / week**.

The 30-worktree × 17 MB anecdote almost certainly clears this — but the **discipline is to measure
first**. Do not build on the anecdote; build on the §35 numbers. Explicitly *not* a trigger:
first-clone / hydration spikes (one-time, and the §4 shared-basis question, not this one).

**Staged rollout.** (1) Behind config — `git.incremental` default **off**, gated exactly like
`syncGit` is today; full-bundle behavior is the shipped default until proven. (2) **One repo first**
— opt in a single low-stakes repo (or per-workspace flag), watch a two-machine round-trip for a week,
confirm the fallback paths (§5) fire and heal. (3) Widen once green. The conditional
`manifestSchema: 3` (§2.3) means a workspace only advertises schema 3 once it actually emits a
chain, so a half-rolled-out fleet degrades safely (pre-increment clients loudly refuse chained
manifests; they never silently corrupt).

**Test plan sketch.**
- **Unit:** chain build (`^basis` negation for dir/all and pointer/scoped); per-link
  `bundle verify` ordering (base verifies standalone; increment fails against a bare repo, passes
  after ancestors fetched); recompaction triggers (length + byte); `sectionEncShas`/`blobRefs`
  include `packChain`; **fallback on every injected failure** (missing link, corrupt link, absent
  basis, 422 on a link) → full bundle / clean defer, never a mutated target.
- **Two-machine e2e** (design 43's FakeRemote / e2ee harness): base capture → 3 successive
  small commits → assert each pushes an **O(delta)** blob (not O(history)); B applies the chain,
  `git fsck` clean, `git log`/`status`/`stash`/rebase-continue all match; recompact at threshold and
  confirm B still round-trips. **Adversarial:** delete a middle chain-link blob → B defers
  (untouched) → sender recompacts full → B heals. Zero-plaintext grep over stored bytes (§28
  acceptance test) still passes.
- **Real-repo round-trip** (extend design 43's live `caracas` / `savvy-core` validation, 762
  commits): capture base, three real commits, assert three increments each ≪ 17 MB; drive a
  recompaction; a fresh clone reconstructing the full chain fscks clean and matches `git log`
  byte-identically; R2 spot-check confirms ciphertext-only. Measure retention-window blob-count
  interaction (§3) at Solo (30d) and Pro (90d).

## 7. Non-goals (restated)

- **No server / API / D1 / Worker change.** Blobs stay opaque; GC is the existing retention →
  mark → purge with `packChain` encShas added to `blobRefs` at commit (client-side only). The §28
  leakage model is unchanged (the server may now see *more* small blobs per repo instead of one
  large one — a slightly different size/count signal, still no refs/paths/contents; §8 of design 43).
- **No cross-repo or cross-worktree object dedup** beyond the §4 recommendation (which is *not* to
  build it). Each section's chain is independent.
- **No change to file sync**, and **no change to the design-43 §7 recovery *semantics*** — increments
  live strictly inside a section and are invisible to defer/422/removal/conflict handling.

---

## Open questions for the founder

1. **Recompaction defaults.** `MAX_PACK_CHAIN = 20` links and "increments ≥ base bytes" — good
   starting points, or tune straight off the §35 numbers before first ship?
2. **Rollout granularity.** Per-repo opt-in first, or a per-workspace `git.incremental` flag? Per-repo
   is safer for the "one repo first" stage but adds a config surface.
3. **First-capture volume.** Is the non-recurring `~480 MB` (30 worktrees × 17 MB, §4) ever actually
   a problem in practice, or purely a steady-state concern? Only a measurement reopens the
   shared-basis question — do we even want it on the radar?
4. **Retention interaction.** Chains keep more (smaller) blobs reachable within the retention window
   than a single full bundle. At Pro's 90-day window with long-lived worktrees, is the extra
   reachable-blob count worth an explicit tighter recompaction bound, or is `MAX_PACK_CHAIN` enough?
5. **Trigger authority.** Are the §6 thresholds (>~10× sustained amplification, or >few GB/week)
   the right shape, or would you rather gate purely on a single "git re-upload GB/week" number that's
   easier to eyeball on a dashboard?
