# Design 287 — review round 1

Scope: staged roadmap for every recommendation in the September 4 sync/Git audit. Two GPT reviewers examined internal consistency, preserved behavior, ordering, topology, confidentiality and rollback. No Claude/cross-model alignment is claimed. Verdict on first draft: revisions required. At least one round executed code: the read-only Git-directory probe falsified the proposed sibling-copy prerequisite.

## Findings and dispositions

| Finding | Disposition in canonical plan |
|---|---|
| R1: trackedness optimization requires writable live Git directory | F1 uses owned scratch or proven stable read-only enumeration; G1 receives the same constraint; 0555 regression included |
| R2: known cached roster mistaken for current authority | S4 preserves refresh per consumed head; any authenticated freshness replacement is separately designed |
| R3: normalization writer precedes identity convergence | G1 characterizes compatibility first and activates normalization/identity together; first-cut IDs reconciled |
| R4: reused matcher lacks index-only invalidation | F3 probes F1 index/dependency identities before reuse and tests add/rm-cached with no ref/file event |
| R5/A4: tree encryption/root confidentiality and retained nodes implicit | X1 requires encrypted content/path-bearing nodes, ciphertext addresses, bounded traversal, exact roots and explicit client-supplied retention |
| A1: held checkout can move through sibling shared refs | G6 propagates holds across affected shared ref/config effects and defines multi-checkout recovery/CAS boundaries |
| A2: local common-dir identity mistaken for portable continuity | G6 separates observation from birth/install/lifecycle identity, copied IDs, tombstones and authoritative old-writer admission |
| A3: chunks ignore aggregate references and valid repeated occurrences | F7 defines aggregate preflight budgets, occurrence semantics, full reconstruction closure and GC/epoch fixtures |
| A5: object reads mistaken for durable possession | X3/X4 require operation-owned retention, GC-race proofs and explicit process cache invalidation |
| A6: peer identity insufficient for current byte access | X2 scopes current access proof, expiry/audience, fallback and entitlement policy without redefining the product |
| A7: priorities mistaken for hard dependencies | Intro and packages distinguish hard dependencies, measurement inputs and rollout coordination |

Detailed original feedback: `docs/design/notes/287/review1-general.md` and `review1-architecture.md`. Amendments change planning text only. Round 2 reviews these corrections; no fourth round is permitted under the repository's three-round cap.

The document does not choose exact wire IDs, crypto derivations, schema transitions or unresolved conflict policies. Those remain explicit admission requirements for their focused package designs.

Renumbered with roadmap on the new execution baseline; historical reviews were performed against audit basis 3c78a055a.
