const PAT_PREFIX = "rbox_pat_";
const PAT_BODY_CHARS = 43; // base64url(32 random bytes), no padding
const PAT_CHECKSUM_CHARS = 4; // base64url(24 bits of CRC32)
const PAT_BODY_RE = /^[A-Za-z0-9_-]{43}$/;
const PAT_CHECKSUM_RE = /^[A-Za-z0-9_-]{4}$/;

let CRC_TABLE: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(s: string): number {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = table[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checksum(body: string): string {
  const n = crc32(`${PAT_PREFIX}${body}`);
  return bytesToBase64url(new Uint8Array([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]));
}

export function createPatToken(random = crypto.getRandomValues(new Uint8Array(32))): string {
  if (random.length !== 32) throw new Error("PAT entropy must be 32 bytes");
  const body = bytesToBase64url(random);
  return `${PAT_PREFIX}${body}${checksum(body)}`;
}

export function isValidPatToken(token: string): boolean {
  if (!token.startsWith(PAT_PREFIX)) return false;
  const rest = token.slice(PAT_PREFIX.length);
  if (rest.length !== PAT_BODY_CHARS + PAT_CHECKSUM_CHARS) return false;
  const body = rest.slice(0, PAT_BODY_CHARS);
  const got = rest.slice(PAT_BODY_CHARS);
  return PAT_BODY_RE.test(body) && PAT_CHECKSUM_RE.test(got) && got === checksum(body);
}

export function patDisplayPrefix(token: string): string {
  return `${token.slice(0, PAT_PREFIX.length + 8)}...`;
}

export { PAT_PREFIX };
