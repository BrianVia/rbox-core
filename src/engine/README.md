# @rbox/sync

The sync engine behind [rbox](https://rbox.to): end-to-end encrypted, content-addressed
directory sync. It scans a directory into a manifest, plans a three-way reconcile against a
remote manifest, applies the plan through any `BlobStore`, and encrypts blobs client-side so
a server stores only ciphertext and opaque addresses.

Status: pre-release. Bun only (`bun >= 1.4`). The API is the engine rbox ships today and
will change before 1.0.

## Example

```ts
import {
  applyActions, buildIgnoreMatcher, encryptFileToTemp, generateKek,
  LocalBlobStore, reconcile, scanManifest, type Manifest,
} from "@rbox/sync";

const store = new LocalBlobStore("/tmp/store");
const local = await scanManifest("/data/src", buildIgnoreMatcher("/data/src"));
for (const f of local.files) {
  if (f.type === "file") await store.put(f.sha256, await Bun.file(`/data/src/${f.path}`).bytes());
}

const empty: Manifest = { generatedAt: new Date(0).toISOString(), files: [] };
await applyActions("/data/dst", reconcile(empty, empty, local, "device-b", new Date().toISOString()), store);

const kek = generateKek();
const blob = await encryptFileToTemp("/data/src/notes.md", kek); // blob.encSha addresses the ciphertext
```

The full runnable version is `scripts/sync-package-example.ts` in the repository.

## What is in the box

- **Scan and plan.** `scanManifest`, `buildIgnoreMatcher` (gitignore semantics plus
  `.rboxignore`), `diffManifests`, `reconcile`.
- **Apply.** `applyActions` against any `BlobStore` (`has`, `put`, `get`, optional streaming).
- **Encryption.** Convergent AES-256-GCM blob encryption keyed by HKDF over a 32-byte key,
  optional zstd before encryption, recovery phrases, and a worker pool for throughput.
- **Wire formats.** Manifest delta envelopes, the small-blob pack format, and the E2EE
  signed-commit, roster and key-epoch objects under `e2ee/`.

Not included: the rbox server, transport, git repository sync orchestration, and the
daemon. The engine writes its local caches under `.rbox/` inside the synced root and never
scans that directory.

## License

Apache-2.0.
