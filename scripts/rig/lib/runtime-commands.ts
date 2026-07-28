import os from "node:os";
import path from "node:path";
import * as C from "./container.js";
import { NAMES } from "./config.js";
import { deleteImageHashRecord } from "./image-hash-records.js";
import { formatBytes, trimRunDirectories, trimWorkloadCache } from "./gc.js";

export async function down(all: boolean, hashFile: string): Promise<void> {
  const removed: string[] = [];
  for (const name of [NAMES.a, NAMES.b]) {
    await C.stopContainer(name);
    if (await C.deleteContainer(name)) removed.push(`container ${name}`);
  }
  if (await C.networkDelete(NAMES.network)) removed.push(`network ${NAMES.network}`);
  if (all) {
    if (await C.imageDelete(NAMES.image)) removed.push(`image ${NAMES.image}`);
    for (const volume of await C.listRigVolumes()) {
      if (await C.volumeDelete(volume.name)) removed.push(`volume ${volume.name}`);
    }
    for (const image of await C.rigDanglingImages()) {
      if (await C.imageDelete(image.id)) removed.push(`dangling image ${image.id} (${image.size})`);
    }
    try {
      deleteImageHashRecord(hashFile, C.runnerName());
    } catch {
      /* best-effort */
    }
  }
  console.log(removed.length ? `removed:\n  ${removed.join("\n  ")}` : "nothing to remove (already clean)");
}

export async function gc(runsDir: string): Promise<void> {
  await C.ensureRuntimeReady();
  const images = await C.rigDanglingImages();
  let removedImages = 0;
  const imageSizes: string[] = [];
  for (const image of images) if (await C.imageDelete(image.id)) { removedImages++; imageSizes.push(image.size); }
  const volumes = await C.listRigVolumes();
  let removedVolumes = 0;
  const volumeSizes: string[] = [];
  for (const volume of volumes) if (await C.volumeDelete(volume.name)) { removedVolumes++; volumeSizes.push(volume.size); }
  const runs = trimRunDirectories(runsDir);
  const cache = trimWorkloadCache(path.join(os.homedir(), ".cache", "rbox-rig", "workloads"));
  console.log(`rig gc: ${removedImages} dangling images (${imageSizes.join(", ") || "0 B"})`);
  console.log(`rig gc: ${removedVolumes} rig volumes (${volumeSizes.join(", ") || "0 B"})`);
  console.log(`rig gc: ${runs.entries} old runs (${formatBytes(runs.bytes)})`);
  console.log(`rig gc: ${cache.entries} workload-cache entries (${formatBytes(cache.bytes)})`);
}

/** Interleaved guest and dev-worker logs until the caller sends SIGINT/SIGTERM. */
export async function watch(apiUrl: string, repoRoot: string): Promise<number> {
  console.log(`rig watch — [A]/[B] container logs + [srv] wrangler tail (${apiUrl}). Ctrl-C to stop.`);
  const handles: C.StreamHandle[] = [
    C.streamContainerLogs(NAMES.a, { onStdout: (line) => console.log(`[A] ${line}`), onStderr: (line) => console.log(`[A] ${line}`) }),
    C.streamContainerLogs(NAMES.b, { onStdout: (line) => console.log(`[B] ${line}`), onStderr: (line) => console.log(`[B] ${line}`) }),
    C.spawnStream(["bunx", "wrangler", "tail", "rbox-dev-api", "--format", "pretty"], {
      cwd: path.join(repoRoot, "apps", "api"),
      onStdout: (line) => console.log(`[srv] ${line}`),
      onStderr: (line) => console.log(`[srv] ${line}`),
    }),
  ];
  await new Promise<void>((resolve) => {
    const stop = () => {
      for (const handle of handles) {
        try {
          handle.kill("SIGTERM");
        } catch {
          /* best-effort */
        }
      }
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
