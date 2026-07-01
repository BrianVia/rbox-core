/**
 * Build + sign + publish a release (design 14). Run by CI (`release.yml`) and
 * usable locally for testing. Steps:
 *   1. write src/cli/version.ts from the version arg
 *   2. compile the standalone binaries for each target
 *   3. sha256 each; assemble version.json (with immutable versioned paths)
 *   4. sign version.json with RBOX_RELEASE_PRIVATE_KEY (env) → version.json.sig
 *   5. upload binaries (versioned + latest alias) + install.sh + manifest + sig to
 *      the rbox-releases R2 bucket via wrangler, then fetch-back-verify the shas
 *
 * Usage: bun scripts/release.ts <version> [--targets=linux-x64,darwin-arm64] [--no-upload]
 * Env:   RBOX_RELEASE_PRIVATE_KEY (Ed25519 pkcs8 b64url), RBOX_RELEASE_KEY_ID
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { releaseSigningInput } from "../src/cli/upgrade-cmd.js";
import { RELEASE_KEYS } from "../src/cli/release-key.js";

const ROOT = path.resolve(import.meta.dir, "..");
const ALL = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

// The native `@parcel/watcher` binding is platform-specific (design §41). Each
// target embeds ONLY its own package; the other three are `--external`ed so a
// single host can cross-`--compile` without their `.node` bytes being resolved.
// NB: the TARGET's package must be installed on the build host for its watcher to
// embed — otherwise that binary still runs, but degrades to periodic-scan-only.
const PARCEL_PKG: Record<(typeof ALL)[number], string> = {
  "darwin-arm64": "@parcel/watcher-darwin-arm64",
  "darwin-x64": "@parcel/watcher-darwin-x64",
  "linux-arm64": "@parcel/watcher-linux-arm64-glibc",
  "linux-x64": "@parcel/watcher-linux-x64-glibc",
};
const externalFlagsFor = (t: (typeof ALL)[number]): string[] =>
  ALL.filter((o) => o !== t).flatMap((o) => ["--external", PARCEL_PKG[o]]);

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun scripts/release.ts <version> [--targets=...] [--no-upload]");
  process.exit(2);
}
const targets = (arg("targets")?.split(",") ?? [...ALL]).filter((t): t is (typeof ALL)[number] => (ALL as readonly string[]).includes(t));
const upload = !process.argv.includes("--no-upload");
const keyId = process.env.RBOX_RELEASE_KEY_ID ?? RELEASE_KEYS[0]!.keyId;
const tag = `v${version}`;
const dist = path.join(ROOT, "dist");

function sh(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`command failed: ${cmd.join(" ")}`);
}
const sha256File = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// 1. embed the version
fs.writeFileSync(path.join(ROOT, "src/cli/version.ts"), `export const RBOX_VERSION = ${JSON.stringify(version)};\n`);
console.log(`[release] version.ts → ${version}`);

// 2. compile each target.
// The native @parcel/watcher binding is per-platform and its npm package is os/cpu-gated,
// so a single (Ubuntu) build host would only have its own by default. Force-install ALL
// four with `--os=* --cpu=*` so every target can embed its correct `.node` deterministically
// (design §41 §6). release.yml passes the same flags on the frozen install; this repeats it
// so `bun scripts/release.ts` works standalone too.
console.log("[release] ensuring all-platform @parcel/watcher bindings are present");
sh(["bun", "install", "--frozen-lockfile", "--os=*", "--cpu=*"]);

/** Absolute path to a target's native binding, or undefined if not installed. */
function nativeBindingPath(t: (typeof ALL)[number]): string | undefined {
  const p = path.join(ROOT, "node_modules", PARCEL_PKG[t], "watcher.node");
  return fs.existsSync(p) ? p : undefined;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const artifacts: Record<string, { sha256: string; path: string }> = {};
for (const t of targets) {
  const out = path.join(dist, `rbox-${t}`);
  // Fail LOUD if the target's native binding is missing — the binary would still boot
  // (degraded to periodic-scan) but silently ship without the live watcher. A release
  // must embed the real thing, so this is a hard error, not a warning.
  if (!nativeBindingPath(t)) {
    throw new Error(`[release] missing native watcher binding for ${t} (${PARCEL_PKG[t]}); run \`bun install --os=* --cpu=*\``);
  }
  console.log(`[release] build ${t} (embedding ${PARCEL_PKG[t]})`);
  sh(["bun", "build", "--compile", `--target=bun-${t}`, ...externalFlagsFor(t), "./src/cli/index.ts", "--outfile", out]);
  artifacts[`rbox-${t}`] = { sha256: sha256File(out), path: `${tag}/rbox-${t}` };
}

// 3. manifest
const manifest = { version, keyId, artifacts, releasedAt: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? Date.now()) * (process.env.SOURCE_DATE_EPOCH ? 1000 : 1)).toISOString() };
const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
fs.writeFileSync(path.join(dist, "version.json"), manifestBytes);

// 4. sign version.json over the domain-tagged exact bytes
const privB64 = process.env.RBOX_RELEASE_PRIVATE_KEY;
if (!privB64) throw new Error("RBOX_RELEASE_PRIVATE_KEY not set");
const priv = createPrivateKey({ key: Buffer.from(privB64, "base64url"), format: "der", type: "pkcs8" });
// Fail BEFORE signing if this private key doesn't match the public key clients
// embed for `keyId` — otherwise we'd publish a perfectly-signed manifest that
// every client rejects (a silent, bricked release).
const embedded = RELEASE_KEYS.find((k) => k.keyId === keyId);
if (!embedded) throw new Error(`keyId ${keyId} is not in the embedded RELEASE_KEYS — clients would reject this release`);
const derivedPub = Buffer.from((createPublicKey(priv).export({ format: "jwk" }) as { x: string }).x, "base64url").toString("base64url");
if (derivedPub !== embedded.pubKey) {
  throw new Error(`RBOX_RELEASE_PRIVATE_KEY does not match the embedded pubKey for keyId ${keyId} — refusing to sign a release clients can't verify`);
}
const sig = edSign(null, Buffer.from(releaseSigningInput(manifestBytes)), priv).toString("base64url");
fs.writeFileSync(path.join(dist, "version.json.sig"), sig);
console.log(`[release] signed manifest (keyId ${keyId})`);

if (!upload) {
  console.log(`[release] --no-upload: artifacts in ${dist}`);
  process.exit(0);
}

// 5. upload to rbox-releases (binaries first, then manifest+sig last — U9).
// Pin wrangler to an exact version so the signing/publish step can't pull a
// surprise "latest" off npm at release time (supply-chain hardening).
const WRANGLER = "wrangler@4.27.0";
const put = (key: string, file: string, ct: string) =>
  sh(["bunx", WRANGLER, "r2", "object", "put", `rbox-releases/${key}`, `--file=${path.join(dist, file)}`, `--content-type=${ct}`, "--remote"]);
for (const t of targets) {
  put(`releases/${tag}/rbox-${t}`, `rbox-${t}`, "application/octet-stream"); // immutable versioned
  put(`releases/rbox-${t}`, `rbox-${t}`, "application/octet-stream"); // mutable latest alias
}
put("releases/install.sh", "../scripts/install.sh", "text/x-shellscript");
// fetch-back the binaries and re-verify the signed shas before publishing the manifest
for (const [name, a] of Object.entries(artifacts)) {
  const got = Bun.spawnSync(["bunx", WRANGLER, "r2", "object", "get", `rbox-releases/releases/${a.path}`, "--pipe", "--remote"], { cwd: ROOT });
  if (got.exitCode !== 0) throw new Error(`fetch-back failed for ${name}`);
  if (createHash("sha256").update(got.stdout).digest("hex") !== a.sha256) throw new Error(`fetch-back sha mismatch for ${name} — refusing to publish manifest`);
}
console.log("[release] fetch-back sha verify OK");
put("releases/version.json", "version.json", "application/json");
put("releases/version.json.sig", "version.json.sig", "text/plain");
console.log(`[release] published ${tag}`);
