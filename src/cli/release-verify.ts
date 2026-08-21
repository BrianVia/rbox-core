import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fromB64url, utf8, verify } from "../engine/e2ee/index.js";
import { jsonObject, jsonText, type JsonValue } from "../json.js";
import { RELEASE_KEYS } from "./release-key.js";

const DOMAIN = "rbox-release/v1\n"; // signature domain separator

export interface Artifact {
  sha256: string;
  path: string; // R2 key under releases/, e.g. "v0.0.2/rbox-linux-x64"
}
export interface Manifest {
  version: string;
  keyId: string;
  artifacts: Record<string, Artifact>;
  releasedAt?: string;
}

/** The signed preimage: the domain tag prepended to the EXACT manifest bytes. The
 *  signer (CI) signs this; the client verifies over the same bytes (design 14 U3'). */
export function releaseSigningInput(manifestBytes: Uint8Array): Uint8Array {
  return new Uint8Array([...utf8(DOMAIN), ...manifestBytes]);
}

/** Parse a signature-verified manifest body into its domain type. The signer
 *  never shape-checks what it signs, so a mis-signed or buggy release must fail
 *  here rather than surface as `undefined` deep inside the upgrade path. */
export function parseReleaseManifest(value: JsonValue, tampered = "refusing to upgrade (possible tampered update channel)"): Manifest {
  if (!jsonObject(value) || !jsonText(value.version) || !jsonText(value.keyId) || !jsonObject(value.artifacts)) {
    throw new Error(`release manifest is malformed — ${tampered}`);
  }
  const artifacts: Record<string, Artifact> = {};
  for (const [name, artifact] of Object.entries(value.artifacts)) {
    if (!jsonObject(artifact) || !jsonText(artifact.sha256) || !jsonText(artifact.path)) {
      throw new Error(`release manifest artifact ${name} is malformed — ${tampered}`);
    }
    artifacts[name] = { sha256: artifact.sha256, path: artifact.path };
  }
  const manifest: Manifest = { version: value.version, keyId: value.keyId, artifacts };
  if (jsonText(value.releasedAt)) manifest.releasedAt = value.releasedAt;
  return manifest;
}

/**
 * Verify the detached signature over the RAW manifest bytes against the embedded
 * keyring, then parse. Throws on unknown key id or bad signature — the ONLY way to
 * obtain a trusted Manifest. Parsing happens after the verify passes (we read the
 * untrusted keyId only to select which embedded key to check against).
 */
export function verifyAndParseManifest(manifestBytes: Uint8Array, sigBytes: Uint8Array): Manifest {
  const tampered = "refusing to upgrade (possible tampered update channel)";
  let body: JsonValue;
  try {
    body = JSON.parse(new TextDecoder().decode(manifestBytes)) as JsonValue;
  } catch {
    throw new Error(`release manifest is not valid JSON — ${tampered}`);
  }
  const keyId = jsonObject(body) && jsonText(body.keyId) ? body.keyId : undefined;
  const key = RELEASE_KEYS.find((k) => k.keyId === keyId);
  if (!key) throw new Error(`release manifest names an unknown signing key (${String(keyId)}) — refusing`);
  // A tampered channel may serve a malformed (non-b64url) signature; treat any
  // decode/verify failure as the same security refusal rather than leaking a
  // low-level "invalid characters" decode error to the user.
  let ok = false;
  try {
    ok = verify(fromB64url(key.pubKey), releaseSigningInput(manifestBytes), fromB64url(new TextDecoder().decode(sigBytes).trim()));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`release signature did not verify — ${tampered}`);
  return parseReleaseManifest(body, tampered);
}

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
