# Review 231 round 2 — folder configuration authority

**Reviewers:** independent adversarial architecture and implementation passes
**Verdict:** NOT ALIGNED
**Disposition:** revise for final capped round

Round 2 confirmed that the registry/admission rule, scope-safe writer,
bind-flag behavior, explicit migration trigger, old JSON contract, daemon boot
admission, and dormant-first delivery boundary were corrected.

## Remaining blockers

1. The marker's config hash had no legitimate hand-edit lifecycle.
2. `rebound` admission still required a strict prior-identity witness that no
   owned record supplied, contradicting registry-is-diagnostic.
3. Parser-level physical overlap rejection could not distinguish grandfathered
   migration entries from later hand edits.
4. Compatibility projection could invert scope→workspace lock order if invoked
   from an admitted operation, and its extra progress record had no owner.
5. Migration's tolerant legacy readers could silently omit corrupt rows.
6. Product defaults, numeric validation, Unicode/name uniqueness, and duplicate
   path behavior were not fully normative.
7. Adoption/export witness contents and the detached repair command were not
   closed contracts.

## Final-round remediation

- Marker records activation only; config validity is established from its own
  bytes/schema on every read.
- Remove rebound from catalog admission. Existing registry rebound remains a
  diagnostic; stream/reset/desired-state gates retain mutation safety.
- Parser rejects only normalized-identical paths. Physical aliases and nested
  roots are accepted/diagnosed; guided add refuses introducing a new overlap.
- Projection never runs inside admission. It owns scope→workspace locks from a
  no-lock context, refuses degraded mutex ownership, and stamps the binding with
  generation+stream+device proof. Convergence derives from those stamps; no
  sidecar progress record exists.
- Migration uses strict legacy evidence readers and refuses corruption.
- Pin exact defaults and closed field/name/path/numeric semantics.
- Define the exact adoption/export policy witnesses and `rbox config add` as the
  idempotent detached-binding transition.
