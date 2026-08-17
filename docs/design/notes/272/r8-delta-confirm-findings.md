# 272 — r8 delta-confirm findings (folded as r9; doc now ALIGNED)

The r8 confirm re-verified every decision the doc carries against `main` on
2026-08-16 and found **no blocker**. Two corrections and three nits, all
transcription — the mechanism (§2.3 strictly-below predicate, §2.4 guard, §2.5
restructure, §2.7 new reason) is unchanged from r8.

## Findings and dispositions

- **C-r8-1 — §2.7's trace hop 2 conflated two caller families. FIXED.**
  `gitReasonOf`'s callers do not all hand it the `why`:
  - `doctor-cmd.ts:249` (`git-sync deferred <repo>: <detail>`), `:255`
    (`git-sync WARNING <repo>: <detail>`) and `:261` (the `git-sync applied`
    held-refs arm) carry the **why-derived detail**; `:249`'s producer is
    `src/cli/sync-git/apply.ts:1063` —
    ``glog(`git-sync deferred ${rel}: ${follow.detail}`)`` — and `follow.detail`
    is what `follow-classify.ts:139` pushed `oracle.why` into.
  - `doctor-cmd.ts:246` parses the `git deferred <age>: <fragment> on
    <checkout> (<repo>)` family, whose fragment is **not** the `why` but
    `renderGitDeferralLine`'s rendered LABEL (`status-view.ts:439-457`, the
    `gitDeferralReasonText(input.reason)` call at `:456` →
    `DEFERRAL_REASON_PRESENTATION[reason].label`), written to the daemon log at
    `src/cli/daemon/daemon.ts:305`.

  Consequence folded into §2.7's copy block: `label: "conflict copies"` is
  **load-bearing**, for exactly the B-r7-1 reason the constant's plural is —
  it normalizes (`toLowerCase().replace(/[ _]+/g, "-")`) to `conflict-copies`,
  and a singular or reworded label falls through to `"conflict"`.

  *Noted, not fixed (out of scope):* `ref-read-unreadable`'s label
  `"unreadable Git refs"` normalizes to `unreadable-git-refs`, which contains
  `unreadable` but not `ref-read-unreadable`, so that family's `git deferred`
  lines already mis-bucket as `unreadable` today. Pre-existing on `main`;
  recorded because it is the same channel the new note pins.

- **C-r8-2 — §7's doctor pin named a module-private symbol. FIXED.**
  `gitReasonOf` (`doctor-cmd.ts:213`) has no `export`. The pin is restated over
  the exported seam `redactGitLogLines` (`:279` → `classifyGitLogMessage` →
  the `git-sync ${klass} reason=${reason} age=${age}` emit at `:272`), with one
  input per channel:
  - `redactGitLogLines("git-sync deferred r: " + CONFLICT_COPY_POPULATION_WHY)`
    ⇒ `"git-sync deferred reason=conflict-copies age=-"` (the `why` half, over
    the exported constant, never a hand-authored literal);
  - `redactGitLogLines("git deferred 1h: conflict copies on branch main (r)")`
    ⇒ `"git-sync deferred reason=conflict-copies age=1h"` (the label half).

  No new export: §0's two-exported-symbols count stands.

- **Nits. FIXED.** C-r7-1's example now uses the literal-token producer
  (`ref-read-unreadable: <marker>`) — the prose "refs could not be read" is
  rescued order-independently by the fallback regex at `doctor-cmd.ts:228` and
  so proves nothing about declaration order; `doctor-cmd.ts:261` added to the
  caller enumeration; §2.3 retitled "Root-scoped matching (B1)"; §6 headed
  through r8.

## Verified clean (re-confirmed in code, no change required)

- **`gitReasonOf` normalization walked by hand.** `detail.toLowerCase()
  .replace(/[ _]+/g, "-")` folds spaces and underscores to hyphens and leaves
  existing hyphens alone; the loop returns the FIRST
  `GIT_DEFERRAL_REASON_SET` member the normalized string `includes()`, and the
  fourteen fallback regexes below it run against the un-normalized lowercase
  detail. Both §2.7 channels land on `conflict-copies` under the adopted
  wording and the adopted declaration position.
- **No vocabulary collisions beyond the two known superstring pairs.** Over
  `GIT_DEFERRAL_REASONS` (`sync-state-model.ts:130-134`) the only ordered pairs
  with `a.includes(b)` are `("ref-read-unreadable", "unreadable")` and the new
  `("conflict-copies", "conflict")`. The
  `local-edits`/`local-index`/`local-operation`/`local-commits`/`local-stash`
  family shares only a prefix and is not an instance either way.
- **The index claim is load-bearing, confirmed.** `ref-read-unreadable` and
  `unreadable` sit at declaration indices **11** and **12** with the
  superstring first, so §7's order-invariant test goes GREEN on today's `main`
  and stays green through the addition — it pins shipped behavior, not only the
  new member.
- Unchanged and re-checked: `GIT_DEFERRAL_REASON_PRECEDENCE`'s compile-time
  totality alias and the load-time size check (`:156-158`, `:165-167`);
  `follow-classify.ts:139`'s exact-equality split; the §2.4 downgrade sites
  (`apply-receipt.ts:541`, `:669`) and the no-`receiptHash`/no-`tokens` store.
