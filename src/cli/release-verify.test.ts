import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RELEASE_KEYS } from "./release-key.js";
import { parseReleaseManifest, verifyReleaseArtifacts, type Manifest } from "./release-verify.js";

// verifyReleaseArtifacts is the SINGLE gate BOTH publish paths go through — the single-shot
// `release.ts` upload and the split `--upload-only` both call uploadRelease() → this. So
// proving it refuses forged/missing/wrong-key/tampered manifests proves NEITHER path can
// upload unverified bytes (design §41). We can't mint a VALID signature here (the release
// private key lives only in the CI `release` env secret), so we assert the refusals — the
// security boundary — which need no valid key.

const VER = "1.2.3";
const KNOWN_KEY = RELEASE_KEYS[0]!.keyId;

/** Build a throwaway dist/ with the given manifest + sig bytes (+ optional binaries). */
function mkdist(opts: { manifest?: string; sig?: string; bins?: Record<string, Buffer> }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-relver-"));
  if (opts.manifest !== undefined) fs.writeFileSync(path.join(dir, "version.json"), opts.manifest);
  if (opts.sig !== undefined) fs.writeFileSync(path.join(dir, "version.json.sig"), opts.sig);
  for (const [name, bytes] of Object.entries(opts.bins ?? {})) fs.writeFileSync(path.join(dir, name), bytes);
  return dir;
}
const manifestJson = (over: Partial<Manifest> = {}) =>
  JSON.stringify({ version: VER, keyId: KNOWN_KEY, artifacts: { "rbox-linux-x64": { sha256: "ab".repeat(32), path: `v${VER}/rbox-linux-x64` } }, ...over });

const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

test("refuses when version.json is missing", () => {
  const d = mkdist({ sig: "x" });
  try {
    expect(() => verifyReleaseArtifacts(d, VER)).toThrow(/version\.json.*missing|missing.*version\.json/i);
  } finally {
    cleanup(d);
  }
});

test("refuses when version.json.sig is missing (unsigned release)", () => {
  const d = mkdist({ manifest: manifestJson() });
  try {
    expect(() => verifyReleaseArtifacts(d, VER)).toThrow(/sig.*missing|unsigned/i);
  } finally {
    cleanup(d);
  }
});

test("refuses a FORGED signature (bytes present, signature garbage)", () => {
  const d = mkdist({ manifest: manifestJson(), sig: "not-a-real-signature" });
  try {
    expect(() => verifyReleaseArtifacts(d, VER)).toThrow(/did not verify|tampered/i);
  } finally {
    cleanup(d);
  }
});

test("refuses a WRONG-KEY manifest (keyId not in the embedded keyring)", () => {
  const d = mkdist({ manifest: manifestJson({ keyId: "deadbeefdeadbeef" }), sig: "AA" });
  try {
    expect(() => verifyReleaseArtifacts(d, VER)).toThrow(/unknown signing key/i);
  } finally {
    cleanup(d);
  }
});

test("refuses a TAMPERED / malformed manifest (not valid JSON)", () => {
  const d = mkdist({ manifest: "{ not json", sig: "AA" });
  try {
    expect(() => verifyReleaseArtifacts(d, VER)).toThrow(/not valid JSON|tampered/i);
  } finally {
    cleanup(d);
  }
});

// A signature proves the bytes came from CI, not that CI produced a well-formed
// manifest. `parseReleaseManifest` is the shape gate behind that signature, so a
// buggy publisher fails here instead of surfacing as `undefined` mid-upgrade. It
// is tested directly: minting a valid signature needs the CI-only private key.
test("manifest parser accepts a well-formed manifest and keeps optional releasedAt", () => {
  const parsed = parseReleaseManifest(JSON.parse(manifestJson({ releasedAt: "2026-08-20T00:00:00.000Z" })));
  expect(parsed).toEqual({
    version: VER,
    keyId: KNOWN_KEY,
    artifacts: { "rbox-linux-x64": { sha256: "ab".repeat(32), path: `v${VER}/rbox-linux-x64` } },
    releasedAt: "2026-08-20T00:00:00.000Z",
  });
});

test.each([
  ["a non-object body", 7],
  ["a missing version", { keyId: KNOWN_KEY, artifacts: {} }],
  ["a non-string version", { version: 2, keyId: KNOWN_KEY, artifacts: {} }],
  ["a missing keyId", { version: VER, artifacts: {} }],
  ["non-object artifacts", { version: VER, keyId: KNOWN_KEY, artifacts: "none" }],
])("manifest parser refuses %s", (_label, body) => {
  expect(() => parseReleaseManifest(body as never)).toThrow(/malformed/);
});

test.each([
  ["a non-object artifact", "binary"],
  ["a missing sha256", { path: `v${VER}/rbox-linux-x64` }],
  ["a non-string path", { sha256: "ab".repeat(32), path: 3 }],
])("manifest parser refuses an artifact with %s", (_label, artifact) => {
  expect(() => parseReleaseManifest({ version: VER, keyId: KNOWN_KEY, artifacts: { "rbox-linux-x64": artifact } } as never))
    .toThrow(/artifact rbox-linux-x64 is malformed/);
});
