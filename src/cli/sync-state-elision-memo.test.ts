import { expect, spyOn, test } from "bun:test";
import * as engine from "../engine/index.js";
import type { FileEntry, Manifest } from "../engine/index.js";
import type { GlobalManifestMeta } from "./sync-state-model.js";
import { auditHash } from "./sync-state-elision.js";

const entry = (path: string): FileEntry => ({ path, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 1 });
const meta = (hash: string): GlobalManifestMeta => ({
  encManifestSha: "b".repeat(64), manifestHash: hash, accountEpoch: 0, keyEpoch: 0, chain: [], chainBytes: 0, snapshotBytes: 0, gitRepos: {},
});

test("design 303: the audit hash is computed once per files array and meta", () => {
  const files = [entry("a"), entry("b")];
  const manifest: Manifest = { generatedAt: "2026-09-05T00:00:00.000Z", files };
  const spy = spyOn(engine, "canonicalManifestHashStreaming");
  try {
    const first = auditHash(manifest, meta("m1"));
    expect(auditHash(manifest, meta("m1"))).toBe(first);
    expect(auditHash({ ...manifest }, meta("m1"))).toBe(first); // same array, new wrapper
    expect(spy).toHaveBeenCalledTimes(1);
    auditHash(manifest, meta("m2")); // different meta → new hash
    expect(spy).toHaveBeenCalledTimes(2);
    auditHash({ ...manifest, files: [...files] }, meta("m1")); // fresh array → always hashes
    expect(spy).toHaveBeenCalledTimes(3);
    auditHash({ ...manifest, generatedAt: "2026-09-06T00:00:00.000Z" }, meta("m1")); // header in key
    expect(spy).toHaveBeenCalledTimes(4);
  } finally {
    spy.mockRestore();
  }
});
