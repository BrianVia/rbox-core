# Design 237 review round 1

Verdict: NOT ALIGNED.

The adversarial review found that the first projection was too broad in one
important place: an action's remote `entry.mtimeMs` comes from the same remote
manifest and must remain exact. Only `expectedLocal.mtimeMs` is a receiver-local
scan observation. It also requested explicit typed error fields (`op` and
`reason`) rather than comparing display text alone.

Confirmed boundaries: preserve action order; parse only last-writer, hashcache,
and dircache metadata; preserve exact state and ordinary file bytes; normalize
only the documented physical timestamps/identities and inventory ordering.

Resolution: design and implementation revised accordingly.
