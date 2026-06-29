import { describe, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, sign as nodeSign, createPublicKey } from "node:crypto";
import { parseSemver, semverGt } from "./semver.js";
import { releaseSigningInput, verifyAndParseManifest } from "./upgrade-cmd.js";
import { RELEASE_KEYS } from "./release-key.js";
import { fromB64url, toB64url } from "../engine/e2ee/index.js";

describe("semver forward-only gate", () => {
  test("compares major/minor/patch", () => {
    expect(semverGt("0.0.2", "0.0.1")).toBe(true);
    expect(semverGt("0.1.0", "0.0.9")).toBe(true);
    expect(semverGt("1.0.0", "0.9.9")).toBe(true);
    expect(semverGt("0.0.1", "0.0.1")).toBe(false); // equal → no upgrade
    expect(semverGt("0.0.1", "0.0.2")).toBe(false); // older → never
  });
  test("release outranks the same-version prerelease; rejects garbage", () => {
    expect(semverGt("0.0.2", "0.0.2-rc.1")).toBe(true);
    expect(semverGt("0.0.2-rc.2", "0.0.2-rc.1")).toBe(true);
    expect(() => parseSemver("nope")).toThrow();
    expect(() => parseSemver("1.2")).toThrow();
  });
});

/** Sign manifest bytes with a raw 32-byte Ed25519 seed-derived... we just generate
 *  a keypair and sign the domain-prefixed bytes the way CI will. */
function signWith(privatePkcs8B64: string, manifestBytes: Uint8Array): string {
  const priv = createPrivateKey({ key: Buffer.from(fromB64url(privatePkcs8B64)), format: "der", type: "pkcs8" });
  return toB64url(new Uint8Array(nodeSign(null, Buffer.from(releaseSigningInput(manifestBytes)), priv)));
}

describe("verifyAndParseManifest (release signature)", () => {
  // A keypair whose PUBLIC key we temporarily trust by matching keyId to a real one
  // would be wrong; instead, generate a keypair and assert that a signature made by
  // a NON-embedded key is rejected, and that tampering/garbage is rejected.
  const kp = generateKeyPairSync("ed25519");
  const privPkcs8 = toB64url(new Uint8Array(kp.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer));
  const manifest = (over: Record<string, unknown> = {}) => new TextEncoder().encode(JSON.stringify({ version: "0.0.2", keyId: RELEASE_KEYS[0]!.keyId, artifacts: { "rbox-linux-x64": { sha256: "ab".repeat(32), path: "v0.0.2/rbox-linux-x64" } }, ...over }));

  test("rejects a signature from a key that isn't the embedded release key", () => {
    const bytes = manifest();
    const sig = signWith(privPkcs8, bytes); // signed by a random key, claiming the real keyId
    expect(() => verifyAndParseManifest(bytes, new TextEncoder().encode(sig))).toThrow(/did not verify/);
  });

  test("rejects an unknown key id", () => {
    const bytes = manifest({ keyId: "deadbeefdeadbeef" });
    const sig = signWith(privPkcs8, bytes);
    expect(() => verifyAndParseManifest(bytes, new TextEncoder().encode(sig))).toThrow(/unknown signing key/);
  });

  test("rejects a tampered manifest (sig over original bytes, body changed)", () => {
    const orig = manifest();
    const sig = signWith(privPkcs8, orig);
    const tampered = manifest({ version: "9.9.9" }); // different bytes
    expect(() => verifyAndParseManifest(tampered, new TextEncoder().encode(sig))).toThrow(/did not verify/);
  });

  test("a manifest signed by the REAL embedded key verifies (round-trip via a matching keypair)", () => {
    // Build a keypair, point a local copy of the keyring entry at its pubkey, and
    // confirm the verify path accepts a correct signature. (We can't use the real
    // private key here — it's offline — so we prove the algorithm end-to-end.)
    const rawPub = Buffer.from((createPublicKey(kp.privateKey).export({ format: "jwk" }) as { x: string }).x, "base64url");
    const realId = RELEASE_KEYS[0]!.keyId;
    const realPub = RELEASE_KEYS[0]!.pubKey;
    RELEASE_KEYS[0]!.pubKey = toB64url(new Uint8Array(rawPub)); // temporarily trust our test key
    try {
      const bytes = manifest();
      const sig = signWith(privPkcs8, bytes);
      const m = verifyAndParseManifest(bytes, new TextEncoder().encode(sig));
      expect(m.version).toBe("0.0.2");
      expect(m.artifacts["rbox-linux-x64"]!.path).toBe("v0.0.2/rbox-linux-x64");
    } finally {
      RELEASE_KEYS[0]!.pubKey = realPub; // restore
      expect(RELEASE_KEYS[0]!.keyId).toBe(realId);
    }
  });
});
