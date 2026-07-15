import { eq, type RouteCtx } from "./shared.js";
import { webSession } from "../clerk.js";

/** Web auth: exchange a Clerk session JWT for an rbox web session (PUBLIC, exact),
 *  so it sits BEFORE authenticate(). */
export async function webRoutes({ req, env, executionCtx, seg }: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "web", "session"])) return webSession(req, env, Date.now(), executionCtx);
  return null;
}
