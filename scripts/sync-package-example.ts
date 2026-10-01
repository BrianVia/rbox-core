import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyActions, buildIgnoreMatcher, decryptFileToPath, diffManifests, encryptFileToTemp,
  generateKek, kekFromPhrase, kekToPhrase, LocalBlobStore, reconcile, scanManifest, type Manifest,
} from "@rbox/sync";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-smoke-"));
const [src, dst] = [path.join(tmp, "src"), path.join(tmp, "dst")];
const store = new LocalBlobStore(path.join(tmp, "store"));
await fs.mkdir(path.join(src, "notes"), { recursive: true });
await fs.mkdir(dst);
await fs.writeFile(path.join(src, "hello.txt"), "hello world\n");
await fs.writeFile(path.join(src, "notes", "a.md"), "# a\n".repeat(1000));

const local = await scanManifest(src, buildIgnoreMatcher(src));
for (const f of local.files) {
  if (f.type === "file") await store.put(f.sha256, await fs.readFile(path.join(src, f.path)));
}
const empty: Manifest = { generatedAt: new Date(0).toISOString(), files: [] };
await applyActions(dst, reconcile(empty, empty, local, "device-b", new Date().toISOString()), store);
const pulled = await scanManifest(dst, buildIgnoreMatcher(dst));
const d = diffManifests(local, pulled);
assert.equal(d.added.length + d.changed.length + d.deleted.length, 0, "dst matches src");
assert.equal(await fs.readFile(path.join(dst, "notes", "a.md"), "utf8"), "# a\n".repeat(1000));

const kek = kekFromPhrase(kekToPhrase(generateKek()));
const enc = await encryptFileToTemp(path.join(src, "notes", "a.md"), kek, tmp);
assert.ok(!(await fs.readFile(enc.ciphertextPath)).includes("# a"), "ciphertext hides plaintext");
const out = path.join(tmp, "roundtrip.md");
await decryptFileToPath(enc.ciphertextPath, kek, enc.plaintextSha, out, { comp: enc.comp, payloadSha: enc.payloadSha });
assert.equal(await fs.readFile(out, "utf8"), "# a\n".repeat(1000));
await assert.rejects(decryptFileToPath(enc.ciphertextPath, generateKek(), enc.plaintextSha, out, { comp: enc.comp, payloadSha: enc.payloadSha }));
console.log(`ok: synced ${local.files.length} entries, encrypted ${enc.cipherSize}B (comp=${enc.comp ?? "none"}), wrong key rejected`);
