# Design 300 review round 1

Verdict: **ALIGNED**.

The adversarial review confirmed that the smallest correct owner is a private
writer-schema operation called by fresh initialization, ordinary writer open,
and WAL takeover only. Normal opens must validate before installation;
read-only, immutable, and foreign observations must never install. The
composite index is justified only if the exact DELETE plan uses its leftmost
prefix for the anti-join and all three columns for the reverse foreign-key
probe. No feature retirement, deletion, new mode, or maintenance machinery is
approved.
