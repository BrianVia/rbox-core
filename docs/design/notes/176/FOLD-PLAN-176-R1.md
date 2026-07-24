# Fold plan — 176 r1 → v2 (orchestrator rulings; BINDING)

Inputs: REVIEW-176-R1-CODEX.md (C1-C9), REVIEW-176-R1-OPUS.md (O1-O8 as
numbered there). ALL findings ACCEPTED. Apply exactly; no new mechanism
beyond what is ruled here.

## The one structural ruling (resolves C1,C2,C3,C4,C5 + Opus BLOCKER jointly)

§2 is REWRITTEN around **keep-mine as confirmed INTENT, executed by the
ordinary push**:

1. `rbox git resolve <repo> keep-mine` (CLI): inspects, prints the plain
   summary + a PRELIMINARY discard preview (best-effort, from pending vs
   LIVE state, clearly labeled "final report is confirmed at publish time"),
   and on `--confirm <token>` writes a token-bound RESOLUTION-INTENT sidecar
   on the RepoRecord (lineage-bound like every 130 sidecar; no BASE change,
   no pending change, no ref change, NOTHING cleared). Token binds the
   snapshot inputs per C6's list.
2. The next push's pending arm: intent present → repo enters capture
   unconditionally (pre-probe still refuses busy/journal-non-terminal per
   174). With the FINAL candidate in hand it computes the DIRECTIONAL
   per-lane discard report (new small predicate built on equalOrFastForward
   + exact-equality helpers — v6's boolean is NOT reused as a report;
   C4,C5, Opus report-direction). Lanes the intent covers are exempted from
   the supersession refusal; preservation runs take-theirs-grade pins for
   every discarded incoming oid reachable locally, and the 174-I3 tombstone
   retention (P as normalizer retention source) carries the pending
   section's chains + generation — O1's lesson, explicitly (Opus
   preservation MAJOR).
3. Publication proceeds; the accepted ACK performs the ordered clears
   (pending/partial/attempt/deferral/INTENT) exactly as 174-B — nothing
   clears pre-ACK (C1). Every pre-ACK failure leaves intent + P intact.
4. BASE: never routed through manual authority. The committed section folds
   through the EXISTING publisher-ack composer arm; branch
   presence/absence crossings that arm cannot express are REFUSED at intent
   time with a plain explanation (C2: no invented A/P; the refused shapes
   are enumerated: pending branch absent locally that BASE holds present,
   and the reserved-173 non-FF-divergent remote — refuse, do not clear;
   Opus re-wedge MAJOR is moot because pending is never cleared early and
   the intent survives until an ACK consumes it).
5. No lockedProof claim anywhere (C3): keep-mine makes no locked ref
   assertions; the push pipeline's existing brackets are the only
   concurrency story, and the intent token's binding (C6) is the staleness
   guard — a bound-input change voids the intent with a plain message.

## Held-skip fix (C7 + Opus guardrail)
Neutralize the held repo's OWN composer-pending disposition by PROVENANCE
(`provenance:"composer"` AND disposition==pending AND the repo's own
classification blockers are all allowlisted) — never by reason string;
independent composer failures (foreign artifacts, veto gates) remain
blocking. Drop the doc's "every pending held repo" overclaim — state the
field shape it provably affects (C7). Non-opportunistic rig assertion stays.

## Language surface (C8, C9, Opus B-underdelivery)
- Frozen GRAMMARS, not just prefixes: enumerate current consumers (rig
  regexes, status parsers, doctor redaction) and pin each with a test; new
  human clause goes in fields those grammars already ignore, or in NEW
  status-only lines — never reshaping parsed segments (C8).
- The `git deferred` shared line keeps its exact current shape for
  daemon/doctor (privacy boundary, C9); the plain-English second sentence is
  a STATUS-RENDERER addition only, reason-templated, including keep-mine as
  the named "publish my work" verb, the two-verb choice, and the "your repo
  is healthy — only rbox's bookkeeping is paused" reassurance (Opus).

## §5 tests: rebuild per the intent model — intent written/void/consumed;
pre-ACK failure table leaves intent+P byte-intact; refused shapes; discard
report directional correctness on the rig wedge fixture; preservation pins +
tombstone carry; grammar-freeze tests; held-skip provenance fix + rig
assertion. §7 field validation unchanged (live savvy-core WITH founder).

Status line → "DRAFT v2 — r1 folded (2-review parallel), awaiting serial
confirmation".
