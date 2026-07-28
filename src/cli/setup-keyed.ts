import fs from "node:fs/promises";
import path from "node:path";
import { runInit } from "./init-cmd.js";
import { startDaemonForUser } from "./autostart-cmd.js";
import { decodeAgentKeyBundle, materializeAgentKey } from "./agent-key-bundle.js";
import { saveCredentials } from "./credentials.js";
import { fetchAccountWorkspaces, type AccountWorkspace } from "./workspace-picker.js";
import { stderrStyle as e } from "./style.js";
import { readStdinTrimmed } from "./read-stdin.js";
import { loadConfig, loadRawState, syncStreamId } from "./config.js";
import { RebindConsentRequiredError } from "./reset-consent.js";

interface ResolvedWorkspace {
  workspaceId: string;
  projectId: string;
  name: string | null;
}

export function hasKeyInput(flags: Record<string, string>): boolean {
  return Boolean(process.env.RBOX_KEY || flags["key-file"] || flags.key);
}

export async function readKeyBundle(flags: Record<string, string>): Promise<string> {
  if (flags.key === "-") return readStdinTrimmed();
  if (flags["key-file"]) {
    if (flags["key-file"] === "true") throw new Error("--key-file requires a path");
    return (await fs.readFile(flags["key-file"], "utf8")).trim();
  }
  if (!process.env.RBOX_KEY) throw new Error("RBOX_KEY is not set");
  return process.env.RBOX_KEY.trim();
}

export function slugifyWorkspaceName(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function defaultTargetSlug(ws: ResolvedWorkspace): string {
  return slugifyWorkspaceName(ws.name ?? "") || ws.workspaceId;
}

export function resolveKeyedWorkspace(input: string, workspaces: AccountWorkspace[]): ResolvedWorkspace {
  const byId = workspaces.find((w) => w.workspaceId === input);
  if (byId) return byId;
  if (/^ws_[A-Za-z0-9]+$/.test(input)) return { workspaceId: input, projectId: "root", name: null };
  const matches = workspaces.filter((w) => w.name === input || (w.name ? slugifyWorkspaceName(w.name) === input : false));
  if (matches.length === 1) return matches[0]!;
  const available = workspaces.map((w) => w.name ?? w.workspaceId).join(", ") || "(none)";
  if (matches.length === 0) throw new Error(`workspace not found: ${input}. Available: ${available}`);
  throw new Error(`workspace name is ambiguous: ${input}. Use the workspace id (${matches.map((w) => w.workspaceId).join(", ")}).`);
}

export async function ensureKeyedTargetDir(target: string, force: boolean): Promise<void> {
  const st = await fs.stat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (st && !st.isDirectory()) throw new Error(`target exists and is not a directory: ${target}`);
  const entries = st ? await fs.readdir(target) : [];
  if (entries.length > 0 && !force) throw new Error(`target directory is not empty: ${target}. Re-run with --force to use it anyway.`);
  await fs.mkdir(target, { recursive: true });
}

export async function persistKeyedCredentials(
  materialized: { token: string; deviceId: string; accountId: string },
  remoteUrl: string
): Promise<void> {
  await saveCredentials({
    token: materialized.token,
    deviceId: materialized.deviceId,
    remoteUrl,
    accountId: materialized.accountId,
  });
}

export async function runKeyedSetup(cwd: string, defaultRemote: string, flags: Record<string, string>): Promise<void> {
  const workspaceArg = flags.workspace;
  if (!workspaceArg || workspaceArg === "true") throw new Error("--workspace requires a name or id");
  const rawBundle = await readKeyBundle(flags);
  const decoded = decodeAgentKeyBundle(rawBundle);
  const remoteUrl = decoded.remoteUrl ?? defaultRemote;
  const workspaces = await fetchAccountWorkspaces(remoteUrl, decoded.bearer);
  const picked = resolveKeyedWorkspace(workspaceArg, workspaces);
  const target = path.resolve(cwd, flags.dir && flags.dir !== "true" ? flags.dir : defaultTargetSlug(picked));
  const prev = await loadConfig(target).catch(() => undefined);
  const raw = await loadRawState(target);
  const nextStream = syncStreamId({ remoteUrl, remoteWorkspaceId: picked.workspaceId, projectId: picked.projectId });
  const priorStream = raw?.stream ?? (prev ? syncStreamId(prev) : undefined);
  if (priorStream && priorStream !== nextStream) throw new RebindConsentRequiredError(target);

  // Materializing the shared key writes the local keystore and environment, so
  // it deliberately follows the rebind refusal above.
  const materialized = await materializeAgentKey(rawBundle, { remoteUrlFallback: defaultRemote });
  await persistKeyedCredentials(materialized, remoteUrl);
  await ensureKeyedTargetDir(target, flags.force === "true");

  const outcome = await runInit(
    {
      workspace: picked.workspaceId,
      project: picked.projectId,
      root: target,
      "no-interactive": "true",
      "pull-only": "true",
      ...(picked.name ? { name: picked.name } : {}),
    },
    { cwd, defaultRemote: remoteUrl, summary: false }
  );
  if (!outcome) return;
  if (flags.daemon === "true") {
    if (flags["pull-only"] === "true") {
      process.stderr.write(`${e.dim("starting pull-only background sync; local changes will not be pushed.")}\n`);
    } else {
      process.stderr.write(`${e.yellow("!")} Shared agent keys are pull-only fleet credentials. A writing agent needs its own key.\n`);
    }
    await startDaemonForUser(outcome.root, { mode: flags["pull-only"] === "true" ? "pull-only" : "read-write" });
  }
}
