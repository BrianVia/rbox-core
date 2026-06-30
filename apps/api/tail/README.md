# rbox Tail Worker (§32 Tier 2)

A stateless [Tail Worker](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)
attached to the rbox api Worker. It pings **#rbox-alerts** on rare-important error
conditions only:

- any **cron** invocation that threw (scheduled GC / notify-sweep failure),
- any **queue-consumer** batch that threw (the path that, after retries, dead-letters
  the new-device-email queue),
- any uncaught **fetch exception** (`outcome: "exception"` — NOT a thrown 4xx/5xx
  `Response`, which the api Worker's top-level boundary converts into a real response).

It deliberately does **not** judge a 5xx-_rate_ spike — that aggregate lives in the
Tier 3 admin cockpit's Cloudflare GraphQL Analytics query (`apps/api/src/admin.ts`).

## Deploy (parent / founder — live Cloudflare)

The api Worker's `wrangler.jsonc` has a `tail_consumers` block **left commented out**
because `wrangler deploy` of the api Worker fails if the tail service doesn't exist
yet (and a merge to `main` auto-deploys the api Worker). So the order is:

```bash
# 1. Deploy the tail worker FIRST (dev, then prod)
cd apps/api/tail
npx wrangler deploy                         # → rbox-dev-tail
npx wrangler deploy --env production         # → rbox-prod-tail

# 2. Set its only secret on BOTH (the #rbox-alerts Slackpipes webhook URL)
npx wrangler secret put SLACKPIPES_ALERTS_WEBHOOK_URL
npx wrangler secret put SLACKPIPES_ALERTS_WEBHOOK_URL --env production

# 3. UNCOMMENT the `tail_consumers` line in apps/api/wrangler.jsonc (dev + prod),
#    then redeploy the api worker so the trace is wired:
cd .. && npx wrangler deploy                  # dev
#    (prod ships via merge → deploy-api.yml, or `npx wrangler deploy --env production`)
```

Absent the secret the tail worker is a safe no-op (it just won't ping).
