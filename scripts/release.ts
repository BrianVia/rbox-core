/**
 * Build + sign + publish a release (design 14). Run by CI (`release.yml`) and
 * usable locally for testing. Steps:
 *   1. write src/cli/version.ts from the version arg
 *   2. compile the standalone binaries for each target
 *   3. sha256 each; assemble version.json (with immutable versioned paths)
 *   4. sign version.json with RBOX_RELEASE_PRIVATE_KEY (env) → version.json.sig
 *   5. upload and fetch-verify immutable binaries, then publish latest aliases,
 *      install.sh, manifest, signature, and changelog to the rbox-releases bucket
 *
 * Usage: bun scripts/release.ts <version> [--targets=linux-x64,darwin-arm64] [--no-upload]
 *        bun scripts/release.ts --dev [--targets=linux-x64,darwin-arm64]
 * Env:   RBOX_RELEASE_PRIVATE_KEY (Ed25519 pkcs8 b64url), RBOX_RELEASE_KEY_ID
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { releaseSigningInput, verifyReleaseArtifacts } from "../src/cli/release-verify.js";
import { RELEASE_KEYS } from "../src/cli/release-key.js";
import { parseSemver, releaseChannelForVersion, semverGt, type ReleaseChannel } from "../src/cli/semver.js";
import { buildCryptoWorkerBundle } from "./build-crypto-worker.js";
import { publishReleaseObjects, wranglerReleaseStore, type ReleaseObjectStore } from "./release-publish.js";

const ROOT = path.resolve(import.meta.dir, "..");
// Intel Macs (darwin-x64) are intentionally unsupported — Apple Silicon + Linux only.
export const ALL = ["darwin-arm64", "linux-arm64", "linux-x64"] as const;
export type ReleaseTarget = (typeof ALL)[number];

// The native `@parcel/watcher` binding is platform-specific (design §41). Each
// target embeds ONLY its own package; the other two are `--external`ed so a
// single host can cross-`--compile` without their `.node` bytes being resolved.
// NB: the TARGET's package must be installed on the build host for its watcher to
// embed — otherwise that binary still runs, but degrades to periodic-scan-only.
export const PARCEL_PKG: Record<ReleaseTarget, string> = {
  "darwin-arm64": "@parcel/watcher-darwin-arm64",
  "linux-arm64": "@parcel/watcher-linux-arm64-glibc",
  "linux-x64": "@parcel/watcher-linux-x64-glibc",
};
export const externalFlagsFor = (t: ReleaseTarget): string[] =>
  ALL.filter((o) => o !== t).flatMap((o) => ["--external", PARCEL_PKG[o]]);

export function checkedInRboxVersion(source: string): string {
  const version = source.match(/const CHECKED_IN_RBOX_VERSION = "([^"]+)";/)?.[1];
  if (!version) throw new Error("src/cli/version.ts has no CHECKED_IN_RBOX_VERSION literal");
  return version;
}

export function deriveDevVersion(checkedInVersion: string, shortSha: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(shortSha)) throw new Error(`invalid short git sha ${JSON.stringify(shortSha)}`);
  return `${checkedInVersion}-dev+${shortSha}`;
}

export function releaseChannelForInput(version: string): ReleaseChannel {
  const parsed = parseSemver(version);
  if (parsed.build !== null) throw new Error(`release version must not contain build metadata: ${version}`);
  return releaseChannelForVersion(version);
}

function replaceOnce(source: string, before: string, after: string): string {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`next installer template expected exactly one ${JSON.stringify(before)}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Derive the opt-in installer without changing the stable install.sh bytes. */
export function nextInstallerSource(stableSource: string): string {
  let source = replaceOnce(
    stableSource,
    'BASE="${RBOX_DOWNLOAD_BASE:-https://api.rbox.to}"',
    'BASE="${RBOX_DOWNLOAD_BASE:-https://api.rbox.to}"\nMANIFEST_BASE="$BASE/next"',
  );
  source = replaceOnce(source, 'URL="$BASE/bin/$BIN"', 'URL="" # assigned from the signed next manifest below');
  source = source.replaceAll("$BASE/version", "$MANIFEST_BASE/version");
  source = replaceOnce(
    source,
    "EXPECTED_SHA=$(printf '%s\\n' \"$SHA_MATCHES\" | sed -n '1p')",
    `EXPECTED_SHA=$(printf '%s\\n' "$SHA_MATCHES" | sed -n '1p')
ARTIFACT_PATHS=$(
  grep -Eo "\\"$BIN\\":\\{[^}]*\\"path\\":\\"v[0-9A-Za-z.+-]+/$BIN\\"" "$MANIFEST" 2>/dev/null |
    sed -E -n 's/.*"path":"([^"]+)".*/\\1/p'
)
ARTIFACT_PATH_COUNT=$(printf '%s\\n' "$ARTIFACT_PATHS" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$ARTIFACT_PATH_COUNT" != "1" ]; then
  echo "rbox: next release manifest did not contain exactly one immutable path for $BIN" >&2
  exit 1
fi
ARTIFACT_PATH=$(printf '%s\\n' "$ARTIFACT_PATHS" | sed -n '1p')
URL="$BASE/bin/$ARTIFACT_PATH"`,
  );
  return source;
}

export type LiveChannelVersion = { status: "found"; version: string } | { status: "missing" };

export function isWranglerMissingDiagnostic(stderr: string): boolean {
  const plain = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  return /(?:^|\n)\s*(?:✘\s*)?(?:\[ERROR\]\s*)?The specified key does not exist\.\s*(?:\n|$)/.test(plain);
}

function nextChannelStore(store: ReleaseObjectStore, nextInstaller: string): ReleaseObjectStore {
  return {
    sha256: (key) => store.sha256(key),
    put: (key, file, contentType) => {
      if (/^releases\/v[^/]+\/rbox-/.test(key)) return store.put(key, file, contentType);
      if (/^releases\/rbox-/.test(key)) return Promise.resolve();
      if (key === "releases/install.sh") return store.put("releases/next/install.sh", nextInstaller, contentType);
      if (key === "releases/version.json") return store.put("releases/next/manifest.json", file, contentType);
      if (key === "releases/version.json.sig") return store.put("releases/next/manifest.json.sig", file, contentType);
      return Promise.reject(new Error(`unexpected mutable next-channel key ${key}`));
    },
  };
}

export async function publishReleaseChannel(opts: {
  channel: ReleaseChannel;
  manifest: ReturnType<typeof verifyReleaseArtifacts>;
  dist: string;
  store: ReleaseObjectStore;
  readLive: (key: string) => LiveChannelVersion | Promise<LiveChannelVersion>;
  stableInstaller: string;
  changelog: string;
}): Promise<void> {
  const manifestKey = opts.channel === "latest" ? "releases/version.json" : "releases/next/manifest.json";
  const before = await opts.readLive(manifestKey);
  if (before.status === "missing" && opts.channel === "latest") {
    throw new Error("could not read the live release manifest — refusing mutable publication");
  }
  if (before.status === "found" && semverGt(before.version, opts.manifest.version)) {
    throw new Error(`live ${opts.channel} release ${before.version} is newer than candidate ${opts.manifest.version} — refusing rollback`);
  }

  if (opts.channel === "latest") {
    await publishReleaseObjects({ manifest: opts.manifest, dist: opts.dist, store: opts.store });
  } else {
    const nextInstaller = path.join(opts.dist, "install-next.sh");
    fs.writeFileSync(nextInstaller, nextInstallerSource(fs.readFileSync(opts.stableInstaller, "utf8")));
    await publishReleaseObjects({
      manifest: opts.manifest,
      dist: opts.dist,
      store: nextChannelStore(opts.store, nextInstaller),
    });
  }

  const after = await opts.readLive(manifestKey);
  if (after.status !== "found" || after.version !== opts.manifest.version) {
    throw new Error(`live ${opts.channel} release did not activate ${opts.manifest.version}`);
  }
  if (opts.channel === "latest") {
    await opts.store.put("releases/changelog.md", opts.changelog, "text/markdown; charset=utf-8");
  }
}

/** Rewrite version.ts only for the duration of a build, restoring its exact bytes on every throw/return. */
export async function withTemporaryVersionFile<T>(file: string, version: string, work: () => Promise<T>): Promise<T> {
  const original = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, `export const RBOX_VERSION = ${JSON.stringify(version)};\n`);
    return await work();
  } finally {
    fs.writeFileSync(file, original);
  }
}

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const positional = argv.filter((value) => !value.startsWith("--"));
const uploadOnly = argv.includes("--upload-only");
let channel: ReleaseChannel | undefined;
try {
  if (!dev && positional.length === 1) channel = releaseChannelForInput(positional[0]!);
} catch {
  // The common usage error below deliberately does not expose parser internals.
}
if ((dev && (positional.length !== 0 || uploadOnly)) || (!dev && (positional.length !== 1 || channel === undefined))) {
  console.error("usage: bun scripts/release.ts <version> [--targets=...] [--no-upload | --upload-only]\n       bun scripts/release.ts --dev [--targets=...]");
  process.exit(2);
}
const versionFile = path.join(ROOT, "src/cli/version.ts");
const checkedInSource = fs.readFileSync(versionFile, "utf8");
const gitSha = dev ? Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }) : undefined;
if (gitSha && gitSha.exitCode !== 0) throw new Error(`git rev-parse failed: ${gitSha.stderr.toString().trim()}`);
const version = dev ? deriveDevVersion(checkedInRboxVersion(checkedInSource), gitSha!.stdout.toString().trim()) : positional[0]!;
const targets = (arg("targets")?.split(",") ?? [...ALL]).filter((t): t is ReleaseTarget => (ALL as readonly string[]).includes(t));
const noUpload = process.argv.includes("--no-upload");
// `--upload-only`: publish a dist/ that an EARLIER job already built + signed + smoke-tested,
// without rebuilding — so the published bytes are exactly the smoked bytes (design §41 §6).
const keyId = process.env.RBOX_RELEASE_KEY_ID ?? RELEASE_KEYS[0]!.keyId;
const tag = `v${version}`;
const dist = path.join(ROOT, "dist");

if (!dev && channel === "latest") {
  const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const firstReleased = changelog.match(/^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/m)?.[1];
  if (firstReleased !== version) {
    throw new Error(`CHANGELOG.md newest release is ${firstReleased ?? "missing"}, expected ${version}`);
  }
}

function sh(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`command failed: ${cmd.join(" ")}`);
}
const sha256File = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/**
 * Publish dist/ to R2 (binaries first, manifest+sig LAST — U9). VERIFICATION IS INTRINSIC:
 * the artifacts uploaded are derived from `verifyReleaseArtifacts` (Ed25519 signature over
 * version.json checked against the release keyring, each binary's sha bound to the signed
 * manifest), so NO caller — split `--upload-only` or single-shot — can reach an upload with
 * unverified bytes (design §41). Fetch-back-verifies the shas before the manifest goes live.
 */
async function uploadRelease(): Promise<void> {
  const m = verifyReleaseArtifacts(dist, version); // throws on missing/forged/wrong-key/tampered
  console.log(`[release] signature verified (keyId ${m.keyId}); publishing ${Object.keys(m.artifacts).length} artifacts`);
  // Pin wrangler to an exact version so the publish step can't pull a surprise "latest".
  const WRANGLER = "wrangler@4.107.0"; // keep in lockstep with the root devDependency pin
  const store = wranglerReleaseStore({ cwd: ROOT, wrangler: WRANGLER });
  const liveManifest = (key: string): LiveChannelVersion => {
    const got = Bun.spawnSync(["bunx", WRANGLER, "r2", "object", "get", `rbox-releases/${key}`, "--pipe", "--remote"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (got.exitCode !== 0) {
      const stderr = got.stderr.toString().trim();
      if (channel === "next" && isWranglerMissingDiagnostic(stderr)) return { status: "missing" };
      throw new Error(`could not read the live ${channel} release manifest — refusing mutable publication${stderr ? `: ${stderr}` : ""}`);
    }
    const parsed = JSON.parse(got.stdout.toString()) as { version?: unknown };
    if (typeof parsed.version !== "string") throw new Error(`live ${channel} release manifest has no valid version`);
    parseSemver(parsed.version);
    return { status: "found", version: parsed.version };
  };
  await publishReleaseChannel({
    channel: channel!,
    manifest: m,
    dist,
    store,
    readLive: liveManifest,
    stableInstaller: path.join(ROOT, "scripts/install.sh"),
    changelog: path.join(ROOT, "CHANGELOG.md"),
  });
  console.log(`[release] ${channel} channel activation${channel === "latest" ? " and changelog publication" : ""} OK`);
  console.log(`[release] published ${tag}`);
}

// PUBLISH-ONLY path: the build+smoke jobs already produced + signed + smoke-tested dist/;
// upload those exact bytes. uploadRelease() re-verifies the signature before anything ships.
if (uploadOnly) {
  await uploadRelease();
  return;
}

await withTemporaryVersionFile(versionFile, version, async () => {
// 1. embed the version for compile; withTemporaryVersionFile restores the checkout in finally.
console.log(`[release] version.ts → ${version}`);

// 2. compile each target.
// The native @parcel/watcher binding is per-platform and its npm package is os/cpu-gated,
// so a single (Ubuntu) build host would only have its own by default. Force-install ALL
// three with `--os=* --cpu=*` so every target can embed its correct `.node` deterministically
// (design §41 §6). release.yml passes the same flags on the frozen install; this repeats it
// so `bun scripts/release.ts` works standalone too.
console.log("[release] ensuring all-platform @parcel/watcher bindings are present");
sh(["bun", "install", "--frozen-lockfile", "--os=*", "--cpu=*"]);

/** Absolute path to a target's native binding, or undefined if not installed. */
function nativeBindingPath(t: ReleaseTarget): string | undefined {
  const p = path.join(ROOT, "node_modules", PARCEL_PKG[t], "watcher.node");
  return fs.existsSync(p) ? p : undefined;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
buildCryptoWorkerBundle();
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
  sh(["bun", "build", "--compile", "--minify", "--splitting", `--target=bun-${t}`, ...externalFlagsFor(t), "./src/cli/index.ts", "--outfile", out]);
  artifacts[`rbox-${t}`] = { sha256: sha256File(out), path: `${tag}/rbox-${t}` };
}

// 3. manifest
// COMPATIBILITY CONTRACT: scripts/install.sh extracts the platform artifact sha
// with constrained grep/sed from this compact JSON shape:
// `"rbox-<os>-<arch>":{"sha256":"<64hex>","path":"v<version>/rbox-<os>-<arch>"}`
// Reordering or pretty-printing artifact fields is a breaking installer change.
const manifest = { version, keyId, artifacts, releasedAt: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? Date.now()) * (process.env.SOURCE_DATE_EPOCH ? 1000 : 1)).toISOString() };
const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
fs.writeFileSync(path.join(dist, "version.json"), manifestBytes);

if (dev) {
  console.log(`[release] --dev: built unsigned artifacts in ${dist}`);
  return;
}

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

// `--no-upload`: stop after build+sign so a separate (smoke-gated) job can publish dist/.
if (noUpload) {
  console.log(`[release] --no-upload: built + signed artifacts in ${dist}`);
  return;
}

// 5. upload to rbox-releases (default single-shot local path). uploadRelease() re-reads and
//    re-verifies the just-signed version.json before uploading — same gate as --upload-only.
await uploadRelease();
});
}

if (import.meta.main) await main();
