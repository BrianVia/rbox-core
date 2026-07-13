# 62 — Quota UX: the 402 is the upgrade moment, so stop mashing it into a string

**Status:** draft — design only (CLI + daemon; NO server change).
**Depends on:** design 13 (plan caps + downgrade grace, shipped), design 45 (status
health verdict, shipped v0.6.3), design 49 (idle backoff, shipped v0.6.6),
design 21 §3.4.1 (`rbox subscribe`, shipped).
**Explicitly out of scope:** any server contract change (the 402 DTO is already the
contract), retention semantics (already enforced server-side — design 66), and in-CLI
upgrade *purchase* (that stays the Stripe checkout `rbox subscribe` already opens).

## 1. Problem

The free tier is 2 GiB (`apps/api/src/plans.ts:18`) and a working dev fills it fast.
The server already does the right thing: every quota wall returns a clean, typed 402.

- blob PUT over cap → `402 {error:"quota_exceeded", used, cap}` (`blobs.ts:156`
  pre-cap fail-fast, `:170` post-grant; multipart init `:215`).
- manifest commit over cap → `402 {error:"quota_exceeded", used, cap}`
  (`workspace-sync.ts:250`).
- workspace-count over cap → `402 {error:"quota_exceeded", limit:"workspaces", cap}`
  (`routes/account.ts:38-40`).
- `GET /v1/account/usage` already returns the whole picture (`billing.ts:101`).

The CLI throws all of it on the floor. Every remote call string-mashes the raw body:
`throw new Error("blob PUT failed: 402 " + await res.text())` (`remote/blobs.ts:18,45`),
`"commit failed: 402 " + body` (`remote/commits.ts:34,70`), `"workspace create failed:
402 …"` (`remote/api.ts:151`). A foreground `rbox sync` therefore prints
(`index.ts:604`):

```
rbox: blob PUT failed: 402 {"error":"quota_exceeded","used":2147483648,"cap":2147483648}
```

That is the single most important conversion moment in the product — the user has hit
the wall and is deciding whether to pay — rendered as a JSON leak. And there is **no
`rbox usage` command**, so a user who suspects they're near the cap has nowhere to
look but the dashboard.

### 1.1 What the daemon does with a 402 today (the real finding)

Background sync does NOT translate the 402 either — it routes it through the generic
pump-error path (`daemon.ts:344`) and records it as a **design-44-style `halt`**:
`activity.halt = { reason: "blob PUT failed: 402 {json}", op: "push", count }`.
`rbox status` then renders it at the top priority of `healthLine` (`status-view.ts:130`):

```
⚠ sync halted (3s ago) blob PUT failed: 402 {"error":"quota_exceeded","used":…,"cap":…}
```

Two problems with that:

1. **Wrong signal.** `⚠ sync halted` is the mass-delete-guard / corruption-adjacent
   alarm state (design 44). "You're out of space" is a normal, recoverable billing
   condition, not "something is wrong with your data." Reusing the halt channel makes a
   routine upsell read like a disaster.
2. **Wasteful retry, ugly reason.** The op flag is consumed before the op runs
   (`want[op] = false` at `daemon.ts:310`), so a 402 is **not** a 1s hot-loop — but
   it *is* re-attempted on every safety scan (`SAFETY_SYNC_MS` floor, idle-backing to
   5 min per design 49) and on every watcher change and every WS-triggered pull→push.
   Each retry re-throws the same 402, refreshes the halt, and bumps `errRepeat` (logged
   on the 1st hit and every 10th). It never auto-clears until a same-op push *succeeds*.
   So: raw JSON in the halt line, periodic pointless re-uploads against a full account,
   and no distinct "out of storage" state anywhere.

## 2. Decision

Translate the 402 exactly once, at the remote seam, into a typed error; render it
humanely in the CLI; add `rbox usage`; and give the daemon a distinct **soft**
out-of-storage state that backs off and self-heals. No server change.

1. **Typed error.** A `QuotaExceededError { kind: "storage" | "workspaces"; used?;
   cap? }` in `remote/errors.ts`, parsed by one shared `readQuotaExceeded(res)` helper
   (parallel to the existing `readShaMismatch`), used by `remote/blobs.ts`,
   `remote/commits.ts`, and `remote/api.ts`. The string-mashing dies.
2. **CLI rendering.** Human-formatted, action-first:
   - storage: `Out of storage — 2.0 GiB of 2.0 GiB used. Upgrade with `rbox subscribe
     solo` (50 GiB), or free up space and run `rbox sync`.`
   - workspaces: `Workspace limit reached — your plan allows 1. Upgrade with `rbox
     subscribe solo` for unlimited workspaces.`
3. **New `rbox usage` command** rendering `GET /v1/account/usage`: plan, a used/cap
   storage bar, workspace count/limit, retention days, and the read-only flag. Ships
   with `--json` from day one (verbatim passthrough of the API DTO). Lives in the
   `BILLING & MAINTENANCE` help group.
4. **Daemon soft state.** On `QuotaExceededError`, record a new `activity.outOfStorage`
   slot instead of a `halt`; `rbox status` surfaces it as its own line; the pump backs
   off (no per-scan re-upload) and auto-clears on the next successful push or when a
   usage check shows headroom.
5. **Server: nothing.** The 402 DTO and `GET /v1/account/usage` are already the
   contract; this design is entirely client-side.

## 3. Mechanism

### 3.1 Parse once, at the seam (`remote/errors.ts`)

```ts
export class QuotaExceededError extends Error {
  constructor(
    readonly kind: "storage" | "workspaces",
    readonly used?: number,
    readonly cap?: number,
  ) { super(quotaMessage(kind, used, cap)); this.name = "QuotaExceededError"; }
}

/** 402 with an `error:"quota_exceeded"` body → typed; anything else → not ours.
 *  Consumes the body once and returns it so the caller keeps its generic diagnostics. */
export async function readQuotaExceeded(res: Response):
  Promise<{ quota: QuotaExceededError | null; text: string }> { … }
```

`quotaMessage` is the pure formatter that produces the Decision-2 strings, so both the
foreground path (the error's `.message`, printed by `index.ts:604` as `rbox: <message>`)
and the daemon path share one source of truth. Bytes render through a **binary** GiB
formatter (caps are defined in GiB — `2 * 1024³`), NOT `status-view.ts:humanBytes`,
which is decimal (`/1000`, "GB"). See §6.

Each raw throw site becomes: try `readQuotaExceeded(res)` first; if `quota`, throw it;
else fall through to today's `throw new Error("… failed: " + status + text)`. The
`workspaces` kind is distinguished by the body's `limit:"workspaces"` discriminator on
the `POST /v1/workspaces` path (`remote/api.ts`).

### 3.2 `rbox usage`

A thin command (`src/cli/usage-cmd.ts`) that GETs `/v1/account/usage` with the device
bearer and renders the DTO, which is (verified, `billing.ts:101`):

```
plan, usedBytes, storageCap (null = unlimited), workspaces, workspaceCap (null =
unlimited), retentionDays, graceUntil, readOnly
```

Human render:

```
plan:       free
storage:    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  2.0 GiB / 2.0 GiB   (100%, read-only)
workspaces: 1 / 1
retention:  0 days (current state only)
```

`--json` prints the DTO verbatim (no reshaping) — the machine-readable pattern this
command establishes; design 67 will extend `--json` to other read commands, so match
this shape (raw API DTO passthrough, not a re-derived object). Register in
`help-registry.ts` under `BILLING & MAINTENANCE`, beside `subscribe`/`billing`.

### 3.3 Daemon: a soft out-of-storage state, not a halt

Add to `DaemonActivity` (`activity.ts`), shape-validated best-effort like every other
slot:

```ts
/** Background sync is blocked by the plan cap (402). SOFT — not a design-44 halt. */
outOfStorage?: { at: string; kind: "storage" | "workspaces"; used?: number; cap?: number };
```

In the pump catch (`daemon.ts:344`), branch on `e instanceof QuotaExceededError`
BEFORE the generic halt bookkeeping:

- set `activity.outOfStorage` (and clear any stale `halt`); do NOT set `halt`.
- **back off:** while `outOfStorage` is set, watcher events, full scans, and pulls keep
  running normally — they just don't *attempt the upload*. Local edits are never queued
  or dropped, because sync is **state-based, not an oplog** (codex review 2026-07-03
  asked; stating it explicitly): the watcher/scanner keep the local picture current on
  disk, and when the state clears, the next push uploads the *latest* state wholesale.
  Suppression loses nothing; it only skips futile wire attempts.
- **retry cadence:** exactly ONE push probe per safety-scan tick (the existing
  `SAFETY_SYNC_MS` timer, idle-backed to 5 min per design 49) while the state is set —
  not per watcher event. There is NO existing account/usage tick in the daemon (codex
  review corrected the draft here): rather than adding a new timer, the same safety-scan
  probe IS the usage re-check — a probe that stops 402ing clears the state. No separate
  `GET /v1/account/usage` polling from the daemon (also keeps design-64 rate-limit
  surface small); on auth/network failure during a probe the state simply persists.
- **auto-clear:** the next successful push (same heal shape as `halt`) clears
  `outOfStorage` and re-arms normal sync.

`status-view.ts` gains a verdict tier between `halt` (1) and live-progress (2), plus a
detail line:

```
⛔ out of storage — 2.0 GiB of 2.0 GiB used · run `rbox usage`, then `rbox subscribe solo`
```

Rendered distinctly from `⚠ sync halted` so the two never blur. The shell-line state
(`shellStateOf`, `activity.ts:121`) gains an `"outofstorage"` rank above `active`,
below `halt`.

## 4. Security & privacy

- **No new data leaves the device.** `used`/`cap` are the user's own numbers, already
  returned to this authenticated principal by the server; `rbox usage` and the messages
  only re-render what the account owner is entitled to see.
- **`--json` is a passthrough**, not a re-fetch of anything broader — it cannot widen
  the DTO's scope, and the DTO is already account-scoped by the bearer.
- **No cross-account inference.** Quota numbers are per-account; nothing here touches
  another account's state or the global blob existence oracle (M7).
- **Sidecar hygiene.** `outOfStorage` is best-effort-parsed and dropped when malformed,
  same as `halt`/`ws`/`active`; a user hand-editing `activity.json` can at worst clear
  or fake a soft banner, never affect sync correctness (the authoritative gate is the
  server 402).

## 5. Test plan

Tight unit loops on the pure pieces; one rig scenario for the wire behavior.

- **Parser (`readQuotaExceeded`):** `402 {error:"quota_exceeded",used,cap}` → storage
  kind with numbers; `402 {error:"quota_exceeded",limit:"workspaces",cap}` → workspaces
  kind; a non-quota 402 and a 400/`sha_mismatch` body → `quota:null`, body preserved for
  the generic path. Body consumed exactly once.
- **Message rendering (`quotaMessage` + binary formatter):** 2 GiB/2 GiB → exact
  `2.0 GiB of 2.0 GiB`; workspace variant; boundary bytes (1023 vs 1024, GiB rounding).
- **`usage --json`:** asserts verbatim DTO passthrough (including `null` caps and
  `readOnly`), and the human render's percent/read-only annotation is derived correctly
  from `usedBytes`/`storageCap`.
- **Daemon classification (offline, `FakeRemote` throwing `QuotaExceededError`):** the
  pump records `outOfStorage`, NOT `halt`; `healthLine` renders the `⛔ out of storage`
  tier; a subsequent successful push clears it; assert no per-safety-scan re-upload
  while the state is set.
- **Rig scenario — cap a dev account low.** The account bootstraps on `free` (2 GiB)
  already; uploading 2 GiB to trip the wall is too slow for the bench. The rig has
  server access and already shells `wrangler` (`scripts/rig/lib/capture.ts` runs
  `wrangler tail`), so seed the over-cap state directly via D1:
  `wrangler d1 execute <rbox-dev-db> --command "UPDATE accounts SET used_bytes = cap_bytes
  WHERE id = '<acct>'"`. Setting `used_bytes = cap_bytes` (equal, not greater) passes the
  `accounts_cap_guard` BEFORE-UPDATE trigger (it only RAISEs when `NEW.used_bytes >
  OLD AND > cap`; migration `0014`), and any subsequent real push trips
  `wouldExceedCap` (`used + size > cap`) → 402. Then assert: (a) foreground `rbox sync`
  prints the friendly `Out of storage —` line, not JSON; (b) `rbox status` shows the
  `⛔ out of storage` state (not `⚠ sync halted`); (c) `rbox usage` shows 100% /
  read-only. A cleaner alternative to the raw D1 poke — worth doing if the rig grows
  more quota scenarios — is a test-only admin knob to set `used_bytes` (the existing
  `POST /v1/admin/account/:id/plan` sets plan+extra but **cannot** express a sub-plan
  cap, so it is insufficient here on its own).

## 6. Out of scope / flagged mismatches

- **Byte formatter split.** `status-view.ts:humanBytes` is *decimal* ("2.1 GB", `/1000`);
  plan caps are *binary* GiB. This design introduces a binary formatter for quota
  surfaces so "2.0 GiB of 2.0 GiB" matches the plan definition. We deliberately do NOT
  retrofit the trash line onto it — out of scope, and the two can coexist.
- **DTO drift from the prompt spec.** The live `usage` DTO also returns `workspaceCap`
  and `graceUntil` beyond the `{plan, usedBytes, storageCap, workspaces, retentionDays,
  readOnly}` set named in the ticket; `rbox usage` renders/passes the *actual* shape.
- **Retention enforcement.** Already shipped (hourly cron prune — see design 66's
  finding; the `plans.ts:11-13` "not yet ENFORCED" comment is stale and design 66
  schedules its correction). `rbox usage` just displays `retentionDays`.
- **In-CLI purchase.** Upgrading still hands off to the Stripe checkout `rbox subscribe`
  opens; we only *point* at it.
- **Proactive "80% full" nudges.** A pre-emptive warning before the hard 402 is a
  reasonable follow-up but is not in this design — this is about the wall itself.
