import type { RouteCtx } from "./shared.js";
import { ipKey, rateLimited } from "../ratelimit.js";

/**
 * Public release distribution (design 14), served from the SEPARATE rbox_releases
 * bucket. All routes are unauthenticated and sit ahead of authenticate().
 */
export async function releaseRoutes({ req, env, url, seg }: RouteCtx): Promise<Response | null> {
  // Never cache a 404 (a cached 404 could mask a just-published object on the
  // edge — design 14 U7).
  const releaseNotFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  // Shared per-IP burst cap applies only after a release route matches, so
  // unrelated traffic does not burn the release budget.
  const releaseLimited = () => rateLimited(env.RL_RELEASE, `rl:${ipKey(req)}`);

  // `curl -fsSL https://api.rbox.to/install.sh | sh`
  if (url.pathname === "/install.sh" && req.method === "GET") {
    const limited = await releaseLimited();
    if (limited) return limited;
    const obj = await env.rbox_releases.get("releases/install.sh");
    if (!obj) return releaseNotFound();
    return new Response(obj.body, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" } });
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
  // `rbox upgrade` downloads from the signed manifest). Name/version validated.
  if (seg[0] === "bin" && req.method === "GET" && (seg.length === 2 || seg.length === 3)) {
    const limited = await releaseLimited();
    if (limited) return limited;
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

  return null;
}
