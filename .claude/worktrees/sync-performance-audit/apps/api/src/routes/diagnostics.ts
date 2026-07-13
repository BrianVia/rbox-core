import { createDiagnosticsReport } from "../diagnostics.js";
import type { Principal } from "../authz.js";
import { eq, type RouteCtx } from "./shared.js";

/** Opt-in support bundle upload. No list/read route in v1; operators inspect D1/R2 directly. */
export async function diagnosticsRoutes({ req, env, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "diagnostics"])) return createDiagnosticsReport(env, p, req, Date.now());
  return null;
}
