/**
 * The embedded release-signing trust root (design 14). `rbox upgrade` verifies the
 * release manifest's Ed25519 signature against THIS public key — so a compromised
 * download channel can't forge an update without the offline-ish release private
 * key (held only in the CI `release` environment secret). Rotation: ship a release
 * (signed by the current key) that adds the next key id here, then sign subsequent
 * releases with the new key.
 */
export interface ReleaseKey {
  keyId: string;
  /** Ed25519 public key, raw 32 bytes, base64url. */
  pubKey: string;
}

/** The keyring (one key in v1). A manifest names its `keyId`; we verify against
 *  the matching key, rejecting unknown key ids. */
export const RELEASE_KEYS: ReleaseKey[] = [
  { keyId: "f98abd21b9ea06b3", pubKey: "lzyeNLb_OYQ45rGE0fYscaCx-EBwHNwUwgqvYymVRGM" },
];
