import fs from "node:fs/promises";
import path from "node:path";
import { RBOX_VERSION } from "./version.js";
import { semverGt } from "./semver.js";
import { homeDir } from "./rbox-paths.js";
import { style } from "./style.js";
import { verifyAndParseManifest, type Manifest } from "./upgrade-cmd.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckState {
  lastCheckedAt: string;
  lastKnownVersion: string;
  lastNudgedVersion: string | null;
}

type FetchBytes = (url: string) => Promise<Uint8Array>;
type VerifyManifest = (manifestBytes: Uint8Array, sigBytes: Uint8Array) => Manifest;

interface UpdateCheckDeps {
  now?: () => Date;
  fetchBytes?: FetchBytes;
  verifyManifest?: VerifyManifest;
}

interface UpdateNudgeDeps {
  isInteractive?: () => boolean;
  writeStderr?: (text: string) => void;
}

const rboxHome = () => path.join(process.env.RBOX_HOME || homeDir(), ".rbox");
export const updateCheckPath = (): string => path.join(rboxHome(), "update-check.json");

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function parseState(raw: string): UpdateCheckState | undefined {
  try {
    const v = JSON.parse(raw) as Partial<UpdateCheckState>;
    if (typeof v.lastCheckedAt !== "string") return undefined;
    if (typeof v.lastKnownVersion !== "string") return undefined;
    if (v.lastNudgedVersion !== null && typeof v.lastNudgedVersion !== "string") return undefined;
    return { lastCheckedAt: v.lastCheckedAt, lastKnownVersion: v.lastKnownVersion, lastNudgedVersion: v.lastNudgedVersion };
  } catch {
    return undefined;
  }
}

export async function readUpdateCheckState(): Promise<UpdateCheckState | undefined> {
  try {
    return parseState(await fs.readFile(updateCheckPath(), "utf8"));
  } catch {
    return undefined;
  }
}

async function writeUpdateCheckState(state: UpdateCheckState): Promise<void> {
  await fs.mkdir(rboxHome(), { recursive: true, mode: 0o700 });
  await fs.writeFile(updateCheckPath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(updateCheckPath(), 0o600).catch(() => {});
}

function due(state: UpdateCheckState | undefined, now: Date): boolean {
  if (!state) return true;
  const last = Date.parse(state.lastCheckedAt);
  return !Number.isFinite(last) || now.getTime() - last >= CHECK_INTERVAL_MS;
}

export function updateAvailableVersion(state: UpdateCheckState | undefined): string | undefined {
  if (!state) return undefined;
  try {
    return semverGt(state.lastKnownVersion, RBOX_VERSION) ? state.lastKnownVersion : undefined;
  } catch {
    return undefined;
  }
}

export function formatUpdateAvailableLine(state: UpdateCheckState | undefined): string | undefined {
  const next = updateAvailableVersion(state);
  return next ? style.dim(`update available ${RBOX_VERSION} → ${next} — run \`rbox upgrade\``) : undefined;
}

/** Best-effort daemon-side update check. Verifies the signed manifest and never downloads artifacts. */
export async function runUpdateCheckIfDue(remoteUrl: string, deps: UpdateCheckDeps = {}): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const prev = await readUpdateCheckState();
  if (!due(prev, now)) return;

  const attempted: UpdateCheckState = {
    lastCheckedAt: now.toISOString(),
    lastKnownVersion: prev?.lastKnownVersion ?? RBOX_VERSION,
    lastNudgedVersion: prev?.lastNudgedVersion ?? null,
  };

  try {
    const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
    const verifyManifest = deps.verifyManifest ?? verifyAndParseManifest;
    const [manifestBytes, sigBytes] = await Promise.all([fetchBytes(`${remoteUrl}/version`), fetchBytes(`${remoteUrl}/version.sig`)]);
    const manifest = verifyManifest(manifestBytes, sigBytes);
    await writeUpdateCheckState({
      lastCheckedAt: attempted.lastCheckedAt,
      lastKnownVersion: manifest.version,
      lastNudgedVersion: prev?.lastKnownVersion === manifest.version ? prev?.lastNudgedVersion ?? null : null,
    });
  } catch {
    await writeUpdateCheckState(attempted).catch(() => {});
  }
}

/** Stderr note for TTY commands, once per detected version. */
export async function maybeNudgeForUpdate(deps: UpdateNudgeDeps = {}): Promise<void> {
  const isInteractive = deps.isInteractive ?? (() => process.stdin.isTTY === true && process.stderr.isTTY === true);
  if (!isInteractive()) return;
  const state = await readUpdateCheckState();
  const next = updateAvailableVersion(state);
  if (!state || !next || state.lastNudgedVersion === next) return;
  (deps.writeStderr ?? ((text) => process.stderr.write(text)))(`${style.dim(`update available ${RBOX_VERSION} → ${next} — run \`rbox upgrade\``)}\n`);
  await writeUpdateCheckState({ ...state, lastNudgedVersion: next }).catch(() => {});
}
