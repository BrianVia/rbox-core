# §127 — Fleet push alerts (cron → Slack #rbox-alerts)

> **Status: 🚧 IN PROGRESS — 2026-07-16 (founder-ordered, "do 2 then 1 then 3").**
> The cockpit (§120 panels) only works if someone looks at it — the Mac's §126 ORIG_HEAD
> strand sat unnoticed for 4 DAYS. This design turns the highest-value attention-strip
> conditions into pushed Slack messages, composing three things that already exist and are
> field-verified: the worker's **hourly cron** (`23 * * * *`, `worker.ts scheduled()`),
> **SlackPipes** (`pingSlackpipes(env, "alerts", text)`, §122 — waitUntil + 5s timeout +
> 1 retry, verified 202 in prod), and the **`device_sync_state`** table (§120, migration 0027).

## Problem

Alert-worthy fleet conditions are now *measured* but nothing *pushes*:

- A device×workspace×project binding deferred **>24h** (the §126 strand class) is visible in
  the cockpit drift table — if you open it.
- A daemon that silently stops reporting (crash-looping, wedged, host offline) just goes
  stale in the table — indistinguishable from "nobody looked."

Both conditions are answerable from **D1 alone**, which the worker reads natively. AE-backed
conditions (propagation p95 bands, capability=0, ingest-drop spikes) need the AE SQL HTTP API
+ a `CF_AE_TOKEN`-class secret in the core worker — deliberately **out of scope for v1**
(cockpit covers them visually; promote later if they earn it).

## Design

### Alert conditions (v1 — D1-only, evaluated hourly on the existing cron)

1. **`drift`** — per binding: a FRESH row (`reported_at >= now − 2.5h`, the §120 staleness
   window) with current deferral age `oldest_deferral_age_ms + (now − reported_at) > 24h`.
   Key: `('drift', device_id, workspace_id, project_id, binding_id)`. Existential across
   bindings — one strand must not mask another. **Resolution requires positive evidence**: a
   FRESH row for the same key with the deferral cleared (`repos_deferred == 0` or age back
   under threshold). A row going STALE neither fires nor resolves drift — the open incident
   stays open (stale-drift renotify semantics per the state machine below: annotated daily
   renotify unless a device-level `reporting_stopped` incident covers it). Round-1 F2: a stale row must never produce a
   "resolved" message — that would claim the deferral cleared when in truth reporting stopped.
2. **`reporting_stopped`** — aggregated **per device** (round-1 F3: per-binding keys would
   turn one dead daemon on a 20-root host into 20 alert+resolve pairs): fires when the
   device's **latest `reported_at` across all its bindings** is older than **2.5h** (aligned
   with the §120 staleness boundary — round-1 F2's 23.5h blind window is gone; worst-case
   time-since-last-report at alert send is ~5.5h: 2.5h onset + up to ~3h evaluation gap
   across the reserved GC hours — round-2 F8). Key: `('reporting_stopped', device_id, '', '', '')`.
   Message carries binding count + last-known drift summary. **Latched** (round-1 F2): once
   fired it resolves ONLY when the device's latest `reported_at` advances past the staleness
   boundary again, or its rows are removed by lifecycle deletes — never by mere age. Ancient
   fully-untracked devices: the latch means they alert ONCE (then daily renotify is suppressed
   after 7 days of no change — the row stays open but goes quiet; founder can silence
   permanently by revoking the device, whose lifecycle delete closes it).
   Note: this also catches "host offline," which is acceptable — the fleet is supposed to be
   always-on, and the message says "stopped reporting," not "broken."

### Dedup / renotify / flap control — new table `alert_state` (next free migration, 0028 as of writing)

Structural columns, not an opaque concatenated key (round-1 F7 — lifecycle deletes need
indexed columns):

```sql
CREATE TABLE alert_state (
  condition           TEXT NOT NULL,           -- 'drift' | 'reporting_stopped'
  device_id           TEXT NOT NULL,
  workspace_id        TEXT NOT NULL DEFAULT '',-- '' for device-level conditions
  project_id          TEXT NOT NULL DEFAULT '',
  binding_id          TEXT NOT NULL DEFAULT '',
  incident_started_at INTEGER NOT NULL,        -- reset on genuine reopen (round-1 F8)
  last_notified_at    INTEGER NOT NULL,
  resolved_at         INTEGER,                 -- kept for reopen detection; pruned later
  resolve_notified_at INTEGER,                 -- resolve message sent for THIS incident (round-2 F4)
  PRIMARY KEY (condition, device_id, workspace_id, project_id, binding_id)
);
```

State machine (round-1 F8 + round-2 F1–F6; one extra column:
`resolve_notified_at INTEGER` — a resolve message fires at most once per incident):

- **Fire (new incident)**: condition true, no open row (none, or `resolved_at` set for
  ≥ 2h). Insert/reset `incident_started_at = now`, `last_notified_at = now`, clear
  `resolved_at` AND `resolve_notified_at`, send "⚠️ …".
- **Continuation (flap debounce)**: condition true, `resolved_at` set **< 2h ago** — same
  incident: clear `resolved_at` only, KEEP `incident_started_at` and `resolve_notified_at`,
  send nothing (unless 24h renotify is due). Round-2 F4: because `resolve_notified_at`
  survives continuation, a fire→resolve→continuation→resolve flap emits NO second resolve —
  at most one ⚠️ and one ✅ per incident, plus daily "still:" lines.
- **Renotify**: condition true, open row, `now − last_notified_at >= 24h` (inclusive), AND
  `now ≤ incident_started_at + 7d` (round-2 F6, exact semantics: after 7 days a continuous
  incident stays OPEN but goes SILENT until a fresh report resolves it or a lifecycle delete
  removes it — genuine long outages also go quiet, explicitly acknowledged; the cockpit
  remains the long-horizon view) → send "still: …", update `last_notified_at`.
  **Stale-drift renotify (round-2 F5, tightened round 3)**: an open drift incident whose
  row has gone stale still renotifies — annotated "binding stale since Xh" — UNLESS an open
  `reporting_stopped` incident for the same device is **actively covering**, defined as:
  open, unresolved, and still inside its own 7d renotify window. When the stopped incident
  resolves (e.g. another binding reports) or goes 7d-silent, stale drift RESUMES its own
  annotated renotify, subject to drift's own 7d window — which in the common chronology
  (drift opened first) has usually expired too, and both go correctly quiet; the exit rule
  matters for the reversed chronology (stopped incident predates the drift incident, e.g.
  drift reopened during an outage), and the exit test pins exactly that chronology.
  Evaluation order is pinned: `reporting_stopped` conditions for all devices are evaluated
  BEFORE drift renotify decisions in the same tick, so coverage is never order-dependent.
- **Resolve**: positive resolution evidence on an open row → set `resolved_at = now`; send
  "✅ resolved … after <now − incident_started_at>" only if `resolve_notified_at` is unset
  for this incident, then stamp it.
- **Prune**: evaluator deletes rows with `resolved_at < now − 30d` (bounded LIMIT).

**Send/state atomicity (round-1 F4, simplified in round-2 F1–F3):** every send is fenced by
a conditional claim WRITE first (`UPDATE … WHERE …` guarded on the pre-claim state;
`meta.changes === 1` = this evaluator owns the send — fences concurrent crons). There is
**NO failure reversion**: the claim is the send's one ticket, spent regardless of delivery
outcome. Round-2 F1/F2 rationale: `pingSlackpipes`'s boolean means *configured-and-attempted*,
not *delivered* — a delivered-but-response-lost send is indistinguishable from a failure, so
"revert and retry" manufactures duplicates, and CAS-safe rollback (round-2 F3) buys
complexity for a message that the next 24h renotify or latch re-fire re-covers anyway.
Semantics: **at most one send operation per claim window**; a genuinely lost message waits
for the next renotify boundary. Accepted for 24h-scale conditions. Concurrent-evaluator
test required (two evaluators, one send, no rollback races).

**Lifecycle (round-1 F7 + round-3 M1)**: `alert_state` joins the deletion inventories —
device revocation and account deletion delete by `device_id` (riding the §120 statements),
workspace purge by `(workspace_id, project_id)` — which reaches only binding-level keys.
Device-level keys are handled by the evaluator instead: an open `reporting_stopped` incident
whose device has **zero `device_sync_state` rows** is **deleted outright** (no Slack
message — administrative removal, not recovery; deleting the row rather than resolving it
means no continuation window and no later misleading ✅). This covers ws-purge of a
device's final binding, and is a no-op for revocation/account-delete (their by-device_id
deletes already removed the key).

The evaluator runs on the 22 "regular maintenance" cron ticks (the two GC-reserved hours
return early, matching the existing `scheduled()` structure) — **worst-case alert latency is
~3h across the GC window** (round-1 F9), fine for 2.5h/24h-scale conditions.

### Message shape (privacy)

Slack is a third-party sink — **stricter than AE is required for content**: messages carry
device *labels*, workspace/project ids (opaque), reason enums, counts, and durations.
**Never paths, never repo names, never emails.** `deferral_reasons` is the closed 15-value
enum — safe. Labels are USER-CONTROLLED strings with weak input bounds (round-1 F6 —
`formatNewAccount` does NO sanitization; the real reusable helper is
`notify.ts::sanitizeLabel`, which strips C0/C1 controls, collapses whitespace, clamps to 80
code points — but does not reject paths or Slack markup). Label policy:

- `sanitizeLabel` first, then Slack-markup neutralization (escape `&`, `<`, `>` — kills
  `<!channel>` / `<@…>` injection).
- A label containing a path separator (`/` or `\`), `@`, or `://` is **omitted** — fall back
  to the truncated device id. Hostnames (the normal label source) never contain these.
- **`project_id` gets the same treatment (round-2 F7)** — it is user-controlled (`--project`,
  arbitrary nonempty strings, `/` explicitly supported): sanitize + escape + truncate, and a
  suspicious value (path-like, `@`, markup) renders as the workspace id alone. `workspace_id`
  is server-generated (`ws_<hex>`) but runs through the same escaper on principle.
- Privacy tests: `/home/user/project`, `C:\Users\x`, `<!channel>`, `<@U123>`, control chars,
  overlength Unicode, `a@b.com` → all render as fallback or neutralized text.

Format (single line, scannable; workspace ids truncated to 8 chars — cockpit has the full id):

```
⚠️ drift: dfinitiv-macbook-pro · ws_2b6e…/root · 2/101 repos deferred 26h (conflict, local-edits)
⚠️ reporting stopped: dfinitiv-macbook-pro · 3 bindings · last report 4h ago (last known: 2 repos deferred)
✅ resolved: dfinitiv-macbook-pro · ws_2b6e…/root · deferral cleared after 27h
```

### Wiring

- New module `apps/api/src/fleet-alerts.ts`: `evaluateFleetAlerts(env, nowMs)` — evaluate,
  fence, send. Sends are **awaited inside the evaluator** (the scheduled handler awaits it;
  no `waitUntil` threading — round-1 F1 verified `ctx` is available but awaiting is simpler
  and sufficient at this send volume).
- SlackPipes (round-1 F1 — the API is event-keyed, not channel-keyed): `SlackpipesEvent`
  gains `"fleet_alert"` and `channelFor()` maps it to `"alerts"`. Calls are
  `pingSlackpipes(env, "fleet_alert", text)`. Its boolean means configured-and-attempted,
  NOT delivered (round-2 F1) — with no claim reversion, nothing consumes it beyond logging. Config-off behavior is already safe, but note BOTH env vars matter:
  `SLACKPIPES_ALERTS_WEBHOOK_URL` explicit, else derived from `SLACKPIPES_WEBHOOK_URL`;
  the zero-network test must unset both.
- `worker.ts scheduled()`: add the call on regular ticks, try/caught with `logErr` like its
  siblings (alerting must never break GC).
- **Plane routing (round-1 F5)**: scan `device_sync_state` via `dbFor(env, "")` — the
  explicit N=1 placeholder gcMark/retention already use; enrich labels via a **separate**
  `dirDb(env)` batch query keyed by `device_id` (globally unique per migration 0013). NO
  cross-plane SQL join. Future sharding = loop over live shards with per-shard enrichment
  (NOT account-delete's two-plane purge split).

### Tests

- Evaluator unit tests with a fake clock + captured pings: fires on >24h fresh drift; stale
  drift row neither fires nor resolves (incident stays open); positive-evidence resolve;
  `reporting_stopped` fires at device level (one alert for N stale bindings), latched until
  `reported_at` advances; flap debounce (resolve+re-fire within 2h = one incident, no
  message); **fire→resolve→continuation→resolve emits exactly one resolve message**;
  renotify at 24h with "still:"; **exact 7d boundary** (renotify at day 7 inclusive, silent
  after; still-open, resolvable); **stale-cover entry AND exit** (drift renotify suppressed
  while a stopped incident actively covers, resumes when it resolves via another binding or
  goes 7d-silent); pinned evaluation order (stopped before drift); GC hours skipped;
  concurrent evaluators → one send (claim fence); **send failure spends the claim — no
  reversion, no retry until the next renotify boundary**; device with zero sync-state rows
  → its stopped-incident ROW IS DELETED and no Slack message is sent; zero network when BOTH webhook vars are
  unset; prune of old resolved rows.
- Migration collision guard (config-time, existing).
- Privacy tests as in §Message shape.

## Non-goals (v1)

- AE-backed conditions (p95 bands, capability=0, ingest drops) — cockpit-only until promoted.
- Per-account alert routing/config — single-operator product; #rbox-alerts is THE sink.
- A generic alerting framework — two conditions, one table, one module. Add conditions as
  rows in a small evaluator list only when they earn it.
- Paging/severity levels — Slack message or nothing.
