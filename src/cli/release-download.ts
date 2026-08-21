import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DOWNLOAD_IDLE_MS, blobDownloadTimeoutMs, fetchWithDeadline } from "./remote/resilient.js";

/** Slow-drip backstop for the artifact download. The rbox binary is ~100 MB, so a flat
 *  small-control deadline would kill a healthy transfer on a thin link; this clamps to the
 *  shared download ceiling (1h by default, `RBOX_NET_BLOB_MAX_TIMEOUT_MS`). The real bound is
 *  the no-progress watchdog below. */
const UPGRADE_DOWNLOAD_MAX_MS = blobDownloadTimeoutMs(Number.MAX_SAFE_INTEGER);

/** Shared by binary and menu-bar upgrades so the app can reuse the release downloader
 * without importing upgrade-cmd.ts and creating a circular import. */
export async function downloadToTemp(url: string, dir: string): Promise<{ tmp: string; sha256: string }> {
  const tmp = path.join(dir, `.rbox.upgrade.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o755); // O_CREAT|O_EXCL|O_WRONLY
  const hash = createHash("sha256");
  // Same no-progress watchdog as blob downloads (remote/blobs.ts): abort only when NO bytes
  // arrive for DOWNLOAD_IDLE_MS, reset on every chunk, and armed BEFORE the fetch so a
  // black-holed connect trips it too instead of hanging `rbox upgrade` forever.
  const ctrl = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new DOMException("upgrade download stalled", "TimeoutError")), DOWNLOAD_IDLE_MS);
  };
  armIdle();
  try {
    const res = await fetchWithDeadline(url, { redirect: "follow", signal: ctrl.signal }, UPGRADE_DOWNLOAD_MAX_MS);
    if (!res.ok || !res.body) throw new Error(`download ${url} → ${res.status}`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // progress → reset the no-progress watchdog
      if (value) {
        hash.update(value);
        fs.writeSync(fd, value);
      }
    }
    return { tmp, sha256: hash.digest("hex") };
  } catch (e) {
    fs.closeSync(fd);
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    if (idle) clearTimeout(idle);
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed on the error path */
    }
  }
}
