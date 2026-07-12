# Design 101 Phase 0 synthetic multipart rig

This measurement-only rig drives the real `putBlobMultipart` client and its real
streaming file-body path against a local in-memory HTTP multipart server. It creates
one crypto-random (incompressible) blob and one highly repetitive (compressible) blob,
then prints each size, completed part count, and the captured numbers-only multipart
metrics line.

Run a quick three-part-per-blob smoke test (24 MiB is the default):

```sh
bun rig/d101-p0/run.ts
```

Optional latency and one-shot transient failure demonstrate wall/gap and retry
instrumentation:

```sh
bun rig/d101-p0/run.ts --mib 24 --latency-ms 20 --fail-part 2
```

Use `--gib 2` for the real multi-GiB multipart shape. The fake server retains parts in
memory, so this needs ample RAM:

```sh
bun rig/d101-p0/run.ts --gib 2
```

The rig binds only to loopback and never contacts or uploads to dev or production R2.
