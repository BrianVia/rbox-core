/**
 * §32 Tier 2 — rbox Tail Worker.
 *
 * A separate, stateless Worker attached to the api Worker via `tail_consumers`. It
 * receives a trace of every api invocation and pings #rbox-alerts
 * (SLACKPIPES_ALERTS_WEBHOOK_URL) on RARE-IMPORTANT conditions ONLY:
 *
 *   - any CRON invocation that threw (scheduled GC / notify sweep failure),
 *   - any QUEUE-consumer batch that threw (the path that, after retries, lands in the
 *     DLQ — design 16's new-device-email queue),
 *   - any uncaught FETCH exception (outcome === "exception"). NOTE: a thrown 4xx/5xx
 *     `Response` is NOT an exception — the api Worker's top-level boundary turns those
 *     into real responses (outcome "ok"), so they never alert here. Only an actual
 *     uncaught throw does.
 *
 * What it deliberately does NOT do: judge a 5xx-RATE spike. That's an aggregate a
 * stateless per-invocation tail can't compute — it lives in the Tier 3 admin
 * cockpit's Cloudflare GraphQL Analytics query (see apps/api/src/admin.ts).
 *
 * Cheap + non-blocking: one summarized POST per tail batch, bounded by a timeout,
 * and any failure is swallowed (a Slackpipes outage must not wedge the tail).
 */

interface Env {
  SLACKPIPES_ALERTS_WEBHOOK_URL?: string;
}

/** Minimal shape of a trace item (subset of @cloudflare/workers-types TraceItem). */
interface TraceItem {
  scriptName?: string | null;
  outcome?: string;
  event?: unknown;
  exceptions?: Array<{ name?: string; message?: string }>;
}

const PING_TIMEOUT_MS = 2500;

/** Classify the trigger so the alert says cron / queue / fetch. */
function eventKind(event: unknown): "cron" | "queue" | "fetch" | "other" {
  if (event && typeof event === "object") {
    if ("cron" in event) return "cron";
    if ("queue" in event) return "queue";
    if ("request" in event) return "fetch";
  }
  return "other";
}

/** An item is alert-worthy iff it carried an uncaught exception OR the runtime marked
 *  the invocation outcome as a hard failure (exception / exceededCpu / etc.). */
function isAlertWorthy(item: TraceItem): boolean {
  if ((item.exceptions?.length ?? 0) > 0) return true;
  const o = item.outcome;
  return o === "exception" || o === "exceededCpu" || o === "exceededMemory";
}

function summarize(item: TraceItem): string {
  const kind = eventKind(item.event);
  const ex = item.exceptions?.[0];
  // Exception name + message can carry app data; the api Worker already logs
  // privacy-safely via logErr, but a tail message to the founder's own #rbox-alerts
  // is acceptable to include the error NAME (not arbitrary bodies). Keep it to name.
  const detail = ex?.name ? ex.name : (item.outcome ?? "exception");
  return `${kind} → ${detail}`;
}

async function postAlert(url: string, text: string): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "tail_alert_failed", errorClass: e instanceof Error ? e.name : typeof e }));
  }
}

export default {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    const url = env.SLACKPIPES_ALERTS_WEBHOOK_URL;
    if (!url) return; // unconfigured → no-op (self-gating)

    const lines: string[] = [];
    for (const item of events) {
      if (isAlertWorthy(item)) lines.push(summarize(item));
    }
    if (lines.length === 0) return; // the overwhelmingly common case → zero cost

    const script = events[0]?.scriptName ?? "rbox-api";
    const head = lines.length === 1 ? "rbox error" : `${lines.length} rbox errors`;
    const text = `:rotating_light: ${head} on \`${script}\`\n` + lines.map((l) => `• ${l}`).join("\n");
    await postAlert(url, text);
  },
};
