import type { FileEntry, Manifest } from "./types.js";
import { canonicalManifestHashStreaming, decodeEnvelope, encodeDeltaEnvelope, foldDelta } from "./manifest-delta.js";
import { existsSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const hex = (n: number): string => n.toString(16).padStart(64, "0");
const files: FileEntry[] = Array.from({ length: 124_000 }, (_, index): FileEntry => index % 23 === 0 ? ({
  path: `generated/link-${index.toString().padStart(6, "0")}/pkg-${index % 251}`,
  type: "symlink", symlinkTarget: `../targets/pkg-${index % 997}`,
  sha256: hex(index + 1), encSha: hex(index + 200_000), payloadSha: hex(index + 400_000), comp: "zstd",
  cipherSize: 96 + index % 4096, size: 20 + index % 80, mode: 0o777,
  mtimeMs: 1_900_000_000_000 + index / 7,
}) : ({
  path: `generated/file-${index.toString().padStart(6, "0")}/pkg-${index % 251}.bin`, type: "file",
  sha256: hex(index + 1), encSha: hex(index + 200_000), payloadSha: hex(index + 400_000), comp: "zstd",
  cipherSize: 96 + index % 4096, size: 80 + index % 4096, mode: index % 17 === 0 ? 0o755 : 0o644,
  mtimeMs: 1_900_000_000_000 + index / 7,
})).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const base: Manifest = { generatedAt: "bench-base", manifestSchema: 4, files };
if (mode === "manifest") {
  console.log(JSON.stringify({ maxRssKb: process.resourceUsage().maxRSS, manifestBytesKb: Math.ceil(Buffer.byteLength(JSON.stringify(base)) / 1024) }));
  process.exit(0);
}
const changed = new Set([7, 61_999, 123_998]);
const target: Manifest = { ...base, generatedAt: "bench-target", files: base.files.map((entry, index) =>
  changed.has(index) ? { ...entry, mode: entry.mode === 0o755 ? 0o644 : 0o755 } : entry) };
const baseHash = canonicalManifestHashStreaming(base);
const encoded = await encodeDeltaEnvelope(base, target, { baseEncSha: "a".repeat(64), baseManifestHash: baseHash, compress: false });
if (mode === "fold") {
  const ready = JSON.stringify({ ready: true, residentKb: Math.ceil(process.memoryUsage().rss / 1024) });
  // Bun can buffer a piped stdout line while this child is paused on stdin,
  // deadlocking the benchmark parent before the measured fold starts. The
  // optional file is a readiness transport only; results remain on stdout.
  if (process.argv[3] && process.argv[4]) {
    writeFileSync(process.argv[3], ready);
    while (!existsSync(process.argv[4])) await new Promise((resolve) => setTimeout(resolve, 5));
  } else {
    console.log(ready);
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  }
}
const start = performance.now();
const decoded = await decodeEnvelope(encoded.bytes);
if (decoded.kind !== "delta") throw new Error("benchmark expected delta envelope");
const folded = foldDelta(base, decoded.ops, decoded.header, baseHash);
const wallMs = performance.now() - start;
if (folded.generatedAt !== target.generatedAt || folded.files.length !== target.files.length) throw new Error("fold mismatch");
console.log(JSON.stringify({ maxRssKb: process.resourceUsage().maxRSS, wallMs }));
