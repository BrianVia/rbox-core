import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyAndParseManifest, type Manifest } from "./upgrade-cmd.js";

/**
 * The single gate every publish path MUST pass through (design §41). Reads
 * `dist/version.json` + `dist/version.json.sig`, VERIFIES the Ed25519 signature over the
 * exact manifest bytes against the embedded release keyring (the same `verifyAndParseManifest`
 * the client uses, so the checks can't diverge), binds it to `expectedVersion`, and confirms
 * every signed artifact's binary is present on disk with a matching sha256.
 *
 * Returns the VERIFIED manifest — its `artifacts` are the ONLY bytes that may be uploaded.
 * Throws on a missing/forged/wrong-key/tampered manifest or any binary sha mismatch, so no
 * caller can reach an upload with unverified bytes. Pure (no network, no process exit) → unit-testable.
 */
export function verifyReleaseArtifacts(dist: string, expectedVersion: string): Manifest {
  const manifestPath = path.join(dist, "version.json");
  const sigPath = path.join(dist, "version.json.sig");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[release] ${manifestPath} missing — the build job must produce + sign dist/ before any upload`);
  }
  if (!fs.existsSync(sigPath)) {
    throw new Error(`[release] ${sigPath} missing — refusing to publish an unsigned release`);
  }
  // Throws on unknown key id or a signature that doesn't verify over the exact bytes.
  const m = verifyAndParseManifest(fs.readFileSync(manifestPath), fs.readFileSync(sigPath));
  if (m.version !== expectedVersion) {
    throw new Error(`[release] signed manifest version ${m.version} != ${expectedVersion} — refusing to publish a mismatched release`);
  }
  for (const [key, a] of Object.entries(m.artifacts)) {
    const bin = path.join(dist, key);
    if (!fs.existsSync(bin)) throw new Error(`[release] signed artifact ${key} has no binary in ${dist} — refusing to publish`);
    const sha = createHash("sha256").update(fs.readFileSync(bin)).digest("hex");
    if (sha !== a.sha256) throw new Error(`[release] ${key} sha ${sha} != signed ${a.sha256} — refusing to publish tampered bytes`);
  }
  return m;
}
