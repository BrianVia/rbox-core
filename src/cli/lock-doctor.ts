/* Standalone lock diagnostic — reveals exactly why workspace locking is
 * refused. Run: rbox-lockdoctor [dir]  (defaults to ~/src). Prints each step
 * and the precise thrown error; never mutates the workspace. */
import { acquireWorkspaceSyncMutex } from "./sync-mutex.js";
import { refreshSystemLockIdentityLedger, resolveDarwinIdentityComponents, hostIdentityLedgerPath } from "../engine/lockfile.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const log = (m: string) => process.stdout.write(m + "\n");
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.homedir(), "src");

log(`rbox lock-doctor — dir=${dir}  platform=${process.platform}`);
log(`~/.rbox exists: ${await fs.stat(path.join(os.homedir(), ".rbox")).then(() => "yes", () => "NO")}`);
log(`host-identity ledger path: ${hostIdentityLedgerPath()}`);
log(`ledger exists: ${await fs.stat(hostIdentityLedgerPath()).then(() => "yes", () => "no (will be created)")}`);

if (process.platform === "darwin") {
  try {
    const id = await resolveDarwinIdentityComponents();
    log(`darwin identity components:`);
    log(`  kern.uuid          = ${id.kernUuid ?? "!! MISSING"}`);
    log(`  kern.bootsessionuuid = ${id.bootSessionUuid ?? "!! MISSING"}`);
    log(`  platform-uuid      = ${id.platformUuid ?? "!! MISSING"}`);
  } catch (e) {
    log(`darwin identity resolution THREW: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
}

try {
  const resolved = await refreshSystemLockIdentityLedger();
  log(`ledger refresh OK: hostId=${resolved.hostId?.slice(0, 12)} bootId=${resolved.bootId?.slice(0, 12)}`);
} catch (e) {
  log(`ledger refresh THREW ↓  (THIS is the cause)`);
  log(`  ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  if (e instanceof Error && e.stack) log(e.stack.split("\n").slice(1, 5).map((l) => "  " + l.trim()).join("\n"));
}

await fs.mkdir(path.join(dir, ".rbox"), { recursive: true }).catch(() => {});
try {
  const m = await acquireWorkspaceSyncMutex(dir, "cli");
  const degraded = (m as { degraded?: { reason: string } }).degraded;
  log(`acquireWorkspaceSyncMutex: ${degraded ? `DEGRADED (reason=${degraded.reason}) ← setup would refuse here` : "OK — locking supported"}`);
} catch (e) {
  log(`acquireWorkspaceSyncMutex THREW: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
}
log("lock-doctor done.");
