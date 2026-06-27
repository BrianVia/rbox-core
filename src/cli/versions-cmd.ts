import fs from "node:fs/promises";
import path from "node:path";
import { decryptFileToPath, writeFileAtomic, type Manifest } from "../engine/index.js";
import { loadKek } from "./keystore.js";
import { RboxApi, RemoteBlobStore } from "./remote.js";
import type { WorkspaceConfig } from "./config.js";

const apiFor = (cfg: WorkspaceConfig) => new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId);

/** `rbox versions [path]` — list commits, or the versions where `path` changed. */
export async function listVersions(cfg: WorkspaceConfig, relPath?: string): Promise<void> {
  const api = apiFor(cfg);
  const versions = await api.versions(50);
  if (!relPath) {
    console.log("seq  when                     device      manifest");
    for (const v of versions) console.log(`${String(v.sequence).padStart(4)} ${v.created_at}  ${(v.device_id ?? "?").padEnd(10)}  ${v.manifest_blob_sha.slice(0, 12)}`);
    return;
  }
  // Show the distinct content shas of `relPath` across recent versions.
  let lastSha = "";
  console.log(`versions of ${relPath} (seq → content sha):`);
  for (const v of [...versions].reverse()) {
    const m = await api.manifestAt(v.sequence);
    const entry = m.files.find((f) => f.path === relPath);
    const sha = entry?.sha256 ?? "(absent)";
    if (sha !== lastSha) {
      console.log(`  @${v.sequence}  ${sha.slice(0, 16)}  ${v.created_at}`);
      lastSha = sha;
    }
  }
}

/** `rbox restore <path>@<seq>` — write the version of `path` from commit `seq`. */
export async function restoreVersion(root: string, cfg: WorkspaceConfig, relPath: string, seq: number): Promise<void> {
  const api = apiFor(cfg);
  const manifest: Manifest = await api.manifestAt(seq);
  const entry = manifest.files.find((f) => f.path === relPath);
  if (!entry) throw new Error(`${relPath} not present at version ${seq}`);
  if (entry.type === "symlink") throw new Error("restore of symlinks not supported");

  const dest = path.join(root, relPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const store = new RemoteBlobStore(api);

  if (entry.encSha) {
    const kek = cfg.kek ?? (await loadKek(cfg.remoteWorkspaceId));
    if (!kek) throw new Error("encrypted blob — run `rbox key import <recovery-phrase>` first");
    const ctTmp = `${dest}.rbox-restore.ct`;
    try {
      await store.getToFile(entry.encSha, ctTmp);
      await decryptFileToPath(ctTmp, kek, entry.sha256, dest);
    } finally {
      await fs.rm(ctTmp, { force: true }).catch(() => {});
    }
  } else {
    await writeFileAtomic(dest, await store.get(entry.sha256));
  }
  console.log(`restored ${relPath} from version ${seq}`);
}
