import { acquireLock, type OwnedLock } from "../engine/lockfile.js";

export interface UpgradeLockContext {
  elevated: boolean;
  lockPath: string;
}

function causeHasCode(error: unknown, codes: readonly string[]): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && codes.includes(String(current.code))) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

async function acquireUpgradeLock(ctx: UpgradeLockContext): Promise<OwnedLock> {
  const result = await acquireLock(ctx.lockPath, { skipIdentityRefresh: true, markerMode: 0o644 });
  if (result.status === "acquired") return result.lock;
  if (result.status === "held") {
    const pid = "marker" in result.inspection ? result.inspection.marker.pid : undefined;
    throw new Error(`another rbox upgrade is already running${pid ? ` (pid ${pid})` : ""} — refusing to run concurrently`);
  }
  if (!ctx.elevated && causeHasCode(result.error, ["EACCES", "EPERM"])) {
    throw new Error(
      `cannot acquire the rbox upgrade lock at ${ctx.lockPath} — if this rbox install is root-owned, retry with \`sudo rbox upgrade\``,
      { cause: result.error },
    );
  }
  throw new Error("cannot acquire the rbox upgrade lock", { cause: result.error });
}

export async function withUpgradeLock<T>(ctx: UpgradeLockContext, work: () => Promise<T>): Promise<T> {
  const lock = await acquireUpgradeLock(ctx);
  let primaryError: unknown;
  try {
    return await work();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const released = await lock.release();
    if (!released.released || !released.durable) {
      const releaseError = new Error("upgrade finished without durably releasing its lock; retry after checking the install directory", { cause: released.error });
      if (primaryError instanceof Error && primaryError.cause === undefined) primaryError.cause = releaseError;
      else if (primaryError === undefined) throw releaseError;
      else console.error(releaseError.message);
    }
  }
}
