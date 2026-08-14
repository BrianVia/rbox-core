import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ByteProgressCallback } from "../engine/blobstore.js";
import { generateKek, LocalBlobStore } from "../engine/index.js";
import { putGitArtifact } from "../cli/sync-git/git-state.js";
import { E2eeRemote, type E2eeApi } from "./e2ee-remote.js";
import { RemoteBlobStore, type RboxApi } from "./remote.js";

test("BlobStore and putGitArtifact thread engine-local onBytes without CLI phases", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-byte-wrap-"));
  try {
    const src = path.join(tmp, "artifact.txt");
    await fs.writeFile(src, "artifact");

    const localBytes: number[] = [];
    const local = new LocalBlobStore(path.join(tmp, "store"));
    await local.putFile("x".repeat(64), src, 8, undefined, (abs) => localBytes.push(abs));
    expect(localBytes).toEqual([8]);

    const artifactBytes: number[] = [];
    const store = {
      async has() {
        return false;
      },
      async put() {},
      async get() {
        return Buffer.alloc(0);
      },
      async putFile(_sha: string, _src: string, size: number, _uploadsDir?: string, onBytes?: ByteProgressCallback) {
        onBytes?.(size);
      },
    };
    await putGitArtifact(store, generateKek(), src, tmp, { onBytes: (abs) => artifactBytes.push(abs) });
    expect(artifactBytes.length).toBeGreaterThan(0);
    expect(artifactBytes.at(-1)).toBeGreaterThan(0);

  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("RemoteBlobStore and E2eeRemote preserve onBytes callbacks through wrappers", async () => {
  const remoteBlobBytes: number[] = [];
  const remoteStore = new RemoteBlobStore({
    putBlobFile: async (_sha: string, _path: string, size: number, _uploadsDir?: string, onBytes?: ByteProgressCallback) => {
      onBytes?.(size);
    },
  } as unknown as RboxApi);
  await remoteStore.putFile("sha", "path", 17, "uploads", (abs) => remoteBlobBytes.push(abs));
  expect(remoteBlobBytes).toEqual([17]);

  const e2eeBytes: number[] = [];
  const api = {
    putBlobFile: async (_sha: string, _path: string, size: number, _uploadsDir?: string, onBytes?: ByteProgressCallback) => {
      onBytes?.(size);
    },
  } as unknown as E2eeApi;
  const remote = new E2eeRemote(api, {} as never, {} as never);
  await remote.putBlobFile("sha", "path", 23, "uploads", (abs) => e2eeBytes.push(abs));
  expect(e2eeBytes).toEqual([23]);
});
