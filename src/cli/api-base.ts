import { PROD_REMOTE } from "./credentials.js";

const apiOverride = process.env.RBOX_API;
if (apiOverride !== undefined && apiOverride !== PROD_REMOTE && process.env.RBOX_API_QUIET !== "1") {
  process.stderr.write(`⚠ RBOX_API override: ${apiOverride}\n`);
}

export const DEFAULT_REMOTE = apiOverride ?? PROD_REMOTE;
