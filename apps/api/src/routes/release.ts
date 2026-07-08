import type { RouteCtx } from "./shared.js";
import type { Env } from "../env.js";
import { ipKey, rateLimited } from "../ratelimit.js";

// Never cache a 404 (a cached 404 could mask a just-published object on the
// edge — design 14 U7).
const releaseNotFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const SHELL_HEADERS = { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300, stale-while-revalidate=3600" };
const AGENT_SH = `#!/bin/sh
set -eu

if ! command -v rbox >/dev/null 2>&1; then
  curl -fsSL --proto '=https' https://rbox.to/install.sh | sh
fi

exec rbox setup "$@"
`;

/**
 * Public release distribution (design 14), served from the SEPARATE rbox_releases
 * bucket. All routes are unauthenticated and sit ahead of authenticate().
 * Gateway half for design 70: apply release RL, then forward cacheable objects.
 */
export async function releaseRoutes({ req, env, exports, url, seg }: RouteCtx): Promise<Response | null> {
  // Shared per-IP burst cap applies only after a release route matches, so
  // unrelated traffic does not burn the release budget.
  const releaseLimited = () => rateLimited(env.RL_RELEASE, `rl:${ipKey(req)}`);

  // `curl -fsSL https://api.rbox.to/install.sh | sh`
  if ((url.pathname === "/install.sh" || url.pathname === "/agent.sh") && req.method === "GET") {
    const limited = await releaseLimited();
    if (limited) return limited;
    return exports.CachedReleases.fetch(req);
  }
  // The signed release manifest + its detached signature (no-cache; `rbox upgrade`
  // verifies the signature against an embedded key before trusting it). Keep the
  // manifest JSON shape aligned with scripts/release.ts; install.sh greps the
  // artifact sha256 from that compact field layout before installing.
  if ((url.pathname === "/version" || url.pathname === "/version.sig") && req.method === "GET") {
    const limited = await releaseLimited();
    if (limited) return limited;
    const key = url.pathname === "/version" ? "releases/version.json" : "releases/version.json.sig";
    const obj = await env.rbox_releases.get(key);
    if (!obj) return releaseNotFound();
    const type = url.pathname === "/version" ? "application/json" : "text/plain; charset=utf-8";
    return new Response(obj.body, { headers: { "content-type": type, "cache-control": "no-cache" } });
  }
  // Binaries: `/bin/rbox-<os>-<arch>` (mutable "latest" alias, short cache — for
  // install.sh only) OR `/bin/v<ver>/rbox-<os>-<arch>` (immutable versioned — what
  // `rbox upgrade` downloads from the signed manifest). Name/version validated by
  // CachedReleases so cache hits can bypass R2 without bypassing this limiter.
  if (seg[0] === "bin" && req.method === "GET" && (seg.length === 2 || seg.length === 3)) {
    const limited = await releaseLimited();
    if (limited) return limited;
    return exports.CachedReleases.fetch(req);
  }

  return null;
}

/** CachedReleases half: pure R2 response contract for design 70's cached entrypoint. */
export async function cachedReleaseResponse(url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/install.sh") {
    const obj = await env.rbox_releases.get("releases/install.sh");
    if (!obj) return releaseNotFound();
    return new Response(obj.body, { headers: SHELL_HEADERS });
  }

  if (url.pathname === "/agent.sh") {
    return new Response(AGENT_SH, { headers: SHELL_HEADERS });
  }

  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] === "bin" && (seg.length === 2 || seg.length === 3)) {
    const versioned = seg.length === 3;
    const ver = versioned ? seg[1]! : null;
    const name = versioned ? seg[2]! : seg[1]!;
    if (!/^rbox-(darwin|linux)-(arm64|x64)$/.test(name)) return releaseNotFound();
    if (versioned && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ver!)) return releaseNotFound();
    const obj = await env.rbox_releases.get(versioned ? `releases/${ver}/${name}` : `releases/${name}`);
    if (!obj) return releaseNotFound();
    const cacheControl = versioned ? "public, max-age=31536000, immutable" : "public, max-age=300";
    return new Response(obj.body, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="rbox"`, "cache-control": cacheControl } });
  }

  return releaseNotFound();
}
