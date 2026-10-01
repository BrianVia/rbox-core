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

## Performance

Engine-only measurements. Network, server and daemon time are excluded unless a row says so.

| What | Result | Conditions | Source |
|---|---|---|---|
| Parallel directory walk | 528 ms serial, 149 ms with 16 slots (3.5x) | 50,000 files, warm cache. AMD Ryzen AI Max+ 395, ext4, Bun 1.4.2, 2026-10-01 | `bun scripts/bench/manifest-walk.ts 50000` |
| Delta manifest decode and fold | 464 ms, no measurable extra memory | 124,000 entries, same host, 2026-10-01. CI fails the build above 2 s | [`manifest-delta.bench.test.ts`](https://github.com/BrianVia/rbox-core/blob/main/src/engine/manifest-delta.bench.test.ts) |
| Batched watcher deletes | 1,401 ms down to 27 ms (52x) | 124,000-entry manifest, 1,000 directory deletes. Re-measured at 27 ms on the host above | [design 290](https://github.com/BrianVia/rbox-core/blob/main/docs/design/290-absent-delete-batching.md), `bun scripts/bench/absent-delete-batching.ts` |
| Encryption, fused worker jobs | 10.0 s down to 1.3 s (−87%), about 14,500 files/s | 20,000 files, 410 MB, warm cache. Ryzen 9 5950X, ext4, Bun 1.3.14, July 2026 | [design 99](https://github.com/BrianVia/rbox-core/blob/main/docs/design/99-fused-crypto-worker-jobs.md) |
| zstd before encryption | 2.17x smaller by bytes. Compress 300–740 MB/s, decompress 1–3.5 GB/s | Real tree, 110,743 files, 6.11 GiB. Apple M-series, July 2026 | [design 79](https://github.com/BrianVia/rbox-core/blob/main/docs/design/79-compress-before-encrypt.md) |
| macOS bulk directory walk | 5.5 s down to 3.2 s (−42%) | Warm full scan, 118,384 files. Apple arm64, APFS, July 2026 | [design 107](https://github.com/BrianVia/rbox-core/blob/main/docs/design/107-darwin-bulk-scan.md), `bun scripts/bench-bulk-scan.ts <dir>` |
| One-file commit payload | 614 bytes instead of a 12.5 MB snapshot | 108,537-file workspace. Measured end to end in rbox, July 2026 | [design 204](https://github.com/BrianVia/rbox-core/blob/main/docs/design/204-delta-scoped-publish.md) |

The crypto pool defaults to 4 workers. Every sweep on x86 and Apple hardware found 4 the
fastest, and more workers ran 1.7–7x slower.

## Run your own server on Cloudflare

This package is the client-side engine only. It has no network code. The server that
stores blobs and orders commits is the rbox API, a Cloudflare Worker in
[`apps/api`](https://github.com/BrianVia/rbox-core/blob/main/apps/api) of the same repository. You can deploy it to your own account and
point the rbox CLI at it. Billing and sign-in are optional and stay off.

You need a Cloudflare account with R2 enabled, and Bun. Plan on Workers Paid. Commit
validation and the hourly maintenance job are likely to exceed the free plan's CPU limit.

1. Clone the repo and log in.
   ```sh
   git clone https://github.com/BrianVia/rbox-core && cd rbox-core && bun install
   cd apps/api && npx wrangler login
   ```
2. Create the database and buckets. Bucket names are global, so pick your own.
   ```sh
   npx wrangler d1 create my-rbox-db
   npx wrangler r2 bucket create my-rbox-blobs
   npx wrangler r2 bucket create my-rbox-releases
   ```
3. Edit the top-level block of `apps/api/wrangler.jsonc`. Do not deploy `env.production`,
   which is bound to `api.rbox.to`.
   - Set `name`, plus `database_name` and `database_id` from step 2. Keep the binding names.
   - Set both `bucket_name` values to your buckets.
   - Delete the `queues` and `send_email` blocks, or create the four queues they name.
     Both are optional.
4. Apply the schema.
   ```sh
   npx wrangler d1 migrations apply my-rbox-db --remote
   ```
5. Set secrets. Save the bootstrap secret, because you log in with it.
   ```sh
   openssl rand -hex 32 | npx wrangler secret put RBOX_BOOTSTRAP_SECRET
   openssl rand -hex 32 | npx wrangler secret put RBOX_RECEIPT_KEY
   openssl rand -hex 32 | npx wrangler secret put RBOX_GRANT_KEY
   openssl rand -hex 32 | npx wrangler secret put RBOX_PLATFORM_SECRET
   ```
   - `RBOX_RECEIPT_KEY` is required. Without it every upload fails.
   - `RBOX_GRANT_KEY` is a speed-up.
   - `RBOX_PLATFORM_SECRET` unlocks the admin routes.
6. Deploy, and note the `workers.dev` URL it prints.
   ```sh
   npx wrangler deploy
   ```
7. On each machine, install the CLI and point it at your server.
   ```sh
   curl -fsSL https://rbox.to/install.sh | sh
   echo 'export RBOX_API=https://<your-worker>.workers.dev' >> ~/.zshrc   # or your shell's profile
   ```
8. On the first machine, create your account and start syncing a folder.
   ```sh
   rbox login --bootstrap <bootstrap-secret> --plan pro
   rbox init
   ```
   Save the recovery phrase it shows. `--plan pro` sets a 250 GiB cap.
9. Add more machines with pairing. Run `rbox pair` on an enrolled machine. Then run the
   `rbox connect <token>` command it prints on the new machine.

Gotchas:

- **Locked account.** An account created without `--plan` gets a 1-byte storage cap, and
  every upload is refused. Fix it with the admin route:
  ```sh
  curl -X POST -H "x-rbox-platform: <platform-secret>" \
    "https://<your-worker>.workers.dev/v1/admin/account/<account-id>/plan?plan=pro"
  ```
- **Missing `RBOX_API`.** Without it, some commands quietly talk to the hosted
  `api.rbox.to` instead of your server.
- **Guard the bootstrap secret.** Anyone with it can create accounts on your server.
- **No browser sign-in.** Plain `rbox login` needs the hosted web app. Use
  `--bootstrap` for the first machine and pairing for the rest.
- **Upgrades.** `rbox upgrade` looks for releases on your server and fails. Re-run the
  install script instead.
- **Old history is never deleted.** Garbage collection and history pruning ship turned off.
  Storage only grows until you enable them.

## License

Apache-2.0.
