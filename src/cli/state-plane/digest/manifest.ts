import { canonicalManifestHashStreaming, type Manifest } from "../../../engine/index.js";
import type { ManifestDigest } from "../ports.js";

/** Manifest integrity stays deliberately distinct from state semantics and
 * physical database/backup identity. */
export function manifestDigest(manifest: Manifest): ManifestDigest {
  return canonicalManifestHashStreaming(manifest) as ManifestDigest;
}
