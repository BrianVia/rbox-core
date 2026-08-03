# Review 119 — CLI version tracking

## Round 1

Adversarial review found the following requirements and decisions:

| Finding | Resolution |
|---|---|
| All `RemoteContext` auth variants must inherit one version-bearing `auth` object; `protoAuth` must not remain an independent duplicate. | Adopted in the design. |
| Header presence must remain distinct from normalized value. Validation is exact, without trimming; malformed-present becomes `NULL`, missing preserves. | Adopted, including the exact regex and 48-character cap. |
| A fresh changed value must write immediately; an unchanged value remains throttled. The update is best-effort and should be a single statement when both fields change. | Adopted. |
| The regex intentionally accepts leading zeroes, `1.2.3-`, and `+`/`.` in the suffix, subject to the overall cap. | Tests will pin boundary/shape behavior rather than substituting a semver parser. |
| `/v1/auth/devices` uses snake-case rows; `/v1/account/devices` uses camel-case rows and an exact-key test. | Both contracts and their tests will be extended. |
| Old-server omission must render `—`, never `undefined`, and JSON should still emit a nullable `lastSeenVersion`. | Adopted. |
| Current `/v1/admin/overview` has aggregates only and no device rows. Inventing an unbounded cross-account list is under-specified and privacy-risky; `/v1/account/devices` is the existing dashboard/admin device-row surface. | Design explicitly extends `/v1/account/devices` and does not invent a new overview schema. |
| Migration 0026 is free and must contain only the additive nullable column. | Adopted. |

Round 2 re-dispatches the written design for an alignment verdict before implementation.

## Round 2

**PASS.** The reviewer confirmed that the design matches the locked behavior and
the current repository. In particular, `rboxVersion()` should return the already
resolved `RBOX_VERSION`; the atomic `CASE` update should bind an integer presence
flag; the existing strict `>` throttle boundary stays unchanged; and
`/v1/account/devices` is the only defined admin/dashboard device-row contract to
extend. No design revisions were required.
