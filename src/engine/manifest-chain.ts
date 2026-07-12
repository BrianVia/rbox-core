export const MAX_MANIFEST_DELTA_CHAIN = 16;

const SHA_RE = /^[0-9a-f]{64}$/;

export function readManifestChain(v: unknown, encManifestSha: string): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_MANIFEST_DELTA_CHAIN) return null;
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const entry of v) {
    if (typeof entry !== "string" || !SHA_RE.test(entry) || entry === encManifestSha || seen.has(entry)) return null;
    seen.add(entry);
    chain.push(entry);
  }
  return chain;
}
