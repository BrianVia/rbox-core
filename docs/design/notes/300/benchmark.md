# Design 300 plane-entry reverse-index benchmark

Measured 2026-09-05 on Linux 7.0.0-30-generic x86_64, Bun 1.4.0, SQLite
3.53.2. The fixture is a real v1 StateStore containing 200,000 entry values,
197,000 live BASE plane rows, and therefore 3,000 unreferenced values. Each
timed run used a fresh clone, enabled foreign keys, excluded index-build time,
ran the exact `collectUnreferencedEntryValues` DELETE, and asserted 3,000
deletions.

| Candidate | Samples (ms) | Median | Plan result |
|---|---:|---:|---|
| none | exceeded 180,000; interrupted | >180,000 ms | scans `plane_entries` |
| `(entry_id)` | 66.72, 66.23, 66.19, 74.14, 71.29 | 66.72 ms | indexed anti-join; partial FK lookup |
| `(entry_id,path,path_order)` | 70.17, 64.75, 65.21, 65.05, 65.85 | 65.21 ms | indexed anti-join; full covering FK lookup |

The unindexed result is a measured lower bound, not the earlier audit value:
the exact 200k-row correlated scan did not finish within three minutes. The
elapsed difference between the two indexed candidates is noise-sized; the
composite wins because the query plan uses it for both operations:

```text
SEARCH p USING COVERING INDEX plane_entries_entry (entry_id=?)
SEARCH plane_entries USING COVERING INDEX plane_entries_entry
  (entry_id=? AND path=? AND path_order=?)
```

With `(entry_id)` alone, the second line is only:

```text
SEARCH plane_entries USING INDEX plane_entries_entry (entry_id=?)
```

This is a collector micro-benchmark, not an end-to-end sync claim.
