# Design 07b — Billing, Plans & Metering (Milestone 7b)

**Status:** draft → pending codex review. **Split:** autonomous quota/accounting/plan-enforcement (build now) + Stripe (needs the user's keys — flagged).
**Implements:** roadmap M7b. Source of truth: `docs/pricing.md`.

## 1. Scope split
- **Autonomous (this milestone):** plan→limits mapping, per-account storage accounting, **server-side quota enforcement** (402 over quota), retention-window-by-plan (wires to M6 prune), usage in `rbox status` + a usage endpoint. Plan is a column on `accounts` (default `free`); set manually / by Stripe later.
- **Human-intervention (deferred, flagged):** Stripe subscriptions (Free/Solo/Pro/Team + per-seat), the `$3/100GB` add-on, checkout/portal URLs, and **webhooks that flip `accounts.plan`**. Needs a Stripe account + API keys (Wrangler secrets) + product/price IDs. Built behind a `STRIPE_SECRET` gate; until provided, plans are managed via an admin/platform route.

## 2. Plan limits (from pricing.md)
```
free: { storageBytes: 2GiB,  workspaces: 1,  projects: 5,   retentionDays: 7  }
solo: { storageBytes: 50GiB, workspaces: ∞,  projects: ∞,   retentionDays: 30 }
pro:  { storageBytes: 250GiB,workspaces: ∞,  projects: ∞,   retentionDays: 90, largeManifests, advancedHydration }
team: { storageBytes: 150GiB/seat (pooled), workspaces: ∞, projects: ∞, retentionDays: 90, roles, audit }
```
Plus `extraStorageBytes` add-on (Stripe-driven later) added to the cap. A `PLANS` constant in `apps/api/src/plans.ts`.

## 3. Storage accounting
Per-account deduped storage = `SELECT SUM(b.size_bytes) FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256 WHERE r.account_id = ?`. Dedup is automatic (one `blob_refs` row per (account, sha)). Computed on demand (and could be cached in an `accounts.used_bytes` column updated on upload/GC — start on-demand, optimize later).

## 4. Quota enforcement (server-side, 402)
- **Storage:** before granting entitlement on a blob upload (`blobPut`/`multipartComplete`), check `used + newBlobSize ≤ cap`. Over → **402** `quota_exceeded` (don't store/grant). For multipart, check at `init` against declared size (cheap reject before uploading parts) AND re-check at complete (authoritative). Already-entitled re-uploads don't double-count (INSERT OR IGNORE).
- **Counts:** at `POST /v1/workspaces`, reject if the account's workspace/project count would exceed the plan (402). (Projects: distinct project_ids within the account's workspaces.)
- **Manifest size:** plan-tied cap (free/solo smaller, pro larger) checked at commit.
- Enforcement reads the account's plan + computes usage; over-quota returns 402 with `{used, cap, plan}` so the client/`status` can show it.

## 5. Plan → capability
- Retention window: M6 prune uses `accounts.plan → retentionDays`. A scheduled/admin prune computes the floor per workspace from its account's window.
- Feature flags (largeManifests, advancedHydration) gate M8/manifest-cap behavior.

## 6. Usage surfacing
- `GET /v1/account/usage` (authed) → `{ plan, usedBytes, storageCap, workspaces, workspaceCap, retentionDays }`.
- `rbox status` shows usage vs cap + plan.

## 7. Stripe (DEFERRED — needs user provisioning)
- `STRIPE_SECRET` + `STRIPE_WEBHOOK_SECRET` Wrangler secrets; product/price IDs in config.
- `POST /v1/billing/checkout` → Stripe Checkout session (upgrade); `POST /v1/billing/portal` → customer portal.
- `POST /v1/stripe/webhook` (signature-verified) → on subscription change, update `accounts.plan` + `extraStorageBytes`.
- Until provisioned: an admin/platform route `POST /v1/admin/account/:id/plan` (platform-secret) sets the plan, so quota enforcement is fully testable now.

## 8. Files touched
| File | Change |
|---|---|
| `apps/api/src/plans.ts` | **new** — PLANS limits map + helpers (cap, retentionDays, counts) |
| `apps/api/src/billing.ts` | **new** — usage accounting, quota checks, usage endpoint, admin set-plan; Stripe stubs gated on STRIPE_SECRET |
| `apps/api/src/blobs.ts` | storage quota check before entitlement (PUT + multipart init/complete) |
| `apps/api/src/authz.ts` | workspace/project count check in createWorkspace |
| `apps/api/src/worker.ts` | route usage + admin set-plan (+ stripe webhook when enabled) |
| `apps/api/migrations/0007_billing.sql` | `accounts.extra_storage_bytes`, optional `used_bytes` cache |
| `src/cli/index.ts` | `rbox status` shows plan + usage |

## 9. Verification
- Set an account to `free` (admin route); upload near 2GiB-equivalent (use a tiny test cap via a test plan or small blobs + a lowered cap) → over-quota upload → 402; under → ok. Create 2 workspaces on free (cap 1) → 2nd → 402. `usage` endpoint reports correct used/cap. Upgrade plan (admin) → higher cap → upload succeeds. Retention: a pro account keeps more history than free (prune floor differs). Stripe path: assert it's gated/no-op without `STRIPE_SECRET`.

## 10. Open questions for review
1. Storage accounting on-demand vs cached `used_bytes` — race under concurrent uploads (two uploads each pass the check, together exceed cap)? Acceptable soft-overage, or need an atomic reserve?
2. Quota at multipart init (declared size, advisory) vs complete (authoritative) — double-check sound?
3. 402 semantics + how the client/daemon surfaces "you're over quota" without data loss (refuse new uploads, keep existing).
4. Team pooled per-seat storage accounting — defer to when Team sharing lands?
