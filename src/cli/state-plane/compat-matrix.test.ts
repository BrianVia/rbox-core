/**
 * The client-skew matrix for U3 (design 222 §7.6, wave 5C).
 *
 * There are four external users on their own upgrade schedules, so "an old
 * binary and a new one meet the same workspace" is a product requirement, not a
 * thought experiment. This suite proves the rows that CAN be proved hermetically
 * and refuses to fake the one that cannot.
 *
 * The contract between versions is exactly two things: the bytes at
 * `.rbox/state.json`, and `classifyStateFormat`'s verdict on them. Everything
 * else — which store opens, which lock is taken — is downstream of that one
 * decision. So every row below is driven through the REAL code path a binary of
 * that vintage runs, on a workspace built by REAL genesis, and the
 * zero-mutation half is measured with `rboxResidue` over the whole `.rbox` tree
 * rather than asserted about one file.
 *
 */
import { expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkState, checkStateGenesis } from "../doctor-state-plane.js";
import {
  type SyncState,
} from "../sync-state-model.js";
import {
  repoRecordsForState, stateFromRepoRecords,
} from "../sync-state-records.js";
import { saveStateUnsafeLegacyOrTest } from "../sync-state-store.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex } from "../sync-mutex.js";
import { admitGenesisAuthority } from "./authority-bootstrap.js";
import {
  AUTHORITY_MARKER_BYTES, AUTHORITY_MARKER_MAGIC, authorityMarkerBytes,
  classifyStateFormat, isAuthorityMarkerBytes, readAuthorityMarkerId,
} from "./authority-marker.js";
import { loadRawState, loadState } from "./adapters/whole-state-compat.js";
import {
  applyLegacyJsonSavePacket, loadLegacyJsonState, loadRawLegacyJsonState,
} from "./adapters/legacy-json-store.js";
import { StateFormatTooNewError } from "./errors.js";
import { rboxResidue } from "./fault-rig.js";
import { sqliteResetPaths, statePath } from "./paths.js";

process.env.RBOX_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-u3-5c-compat-home-"));

const configOf = (root: string): WorkspaceConfig => ({
  schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
  rootPath: root, remoteUrl: "https://example.invalid", token: "",
});

const legacyState = (stream: string): SyncState => ({
  stream, lastSyncedSequence: 12,
  lastSyncedManifest: {
    generatedAt: "2026-01-01T00:00:00.000Z", manifestSchema: 2,
    files: [{ path: "a.txt", sha256: "d".repeat(64), size: 3, mode: 0o644, mtimeMs: 1_700_000_000_000, type: "file" }],
  },
  gitReposRemoved: { "gone/a": "identity-a" },
});

/** A real legacy workspace, composed and published exactly as production does. */
async function legacyWorkspace(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-u3-5c-compat-${prefix}-`));
  const config = configOf(root);
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  const state = legacyState(syncStreamId(config));
  await saveStateUnsafeLegacyOrTest(root, stateFromRepoRecords(state, repoRecordsForState(state)));
  return root;
}

/** A fresh SQLite workspace built by the real genesis admission path. */
async function sqliteWorkspace(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-u3-5c-compat-${prefix}-`));
  await saveConfig(root, configOf(root));
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  try {
    const outcome = await admitGenesisAuthority(root, mutex);
    if (outcome.kind !== "selected" || outcome.authority.kind !== "sqlite-store") {
      throw new Error(`fixture did not establish SQLite authority: ${JSON.stringify(outcome)}`);
    }
  } finally {
    await releaseWorkspaceSyncMutex(mutex);
  }
  expect(await classifyStateFormat(statePath(root))).toBe("authority-marker");
  return root;
}

const rejects = async (body: () => Promise<unknown>): Promise<unknown> => {
  try {
    await body();
    return undefined;
  } catch (error) {
    return error;
  }
};

// ---------------------------------------------------------------------------
// ROW 1 — released OLD binary, candidate (post-`Q`) workspace. Fail closed.

/**
 * `adapters/legacy-json-store.ts` IS the pre-U3 whole-state plane: a 1.x binary
 * reaches `.rbox/state.json` through these four functions and no others. Driving
 * them directly is the closest a single process can get to running the old
 * binary, and it is a real drive — not a simulated refusal.
 */
test("an old binary's every state read and write over a SQLite workspace fails closed", async () => {
  const root = await sqliteWorkspace("old-over-new");
  const stream = syncStreamId(configOf(root));
  const before = rboxResidue(root);

  const attempts: Array<[string, unknown]> = [
    ["loadRawLegacyJsonState", await rejects(() => loadRawLegacyJsonState(root))],
    ["loadLegacyJsonState", await rejects(() => loadLegacyJsonState(root, stream, () => undefined))],
    ["applyLegacyJsonSavePacket", await rejects(() => applyLegacyJsonSavePacket(root, {
      expectedStream: stream, expectedNonce: "legacy", sourceGlobalSeq: 99, repos: [],
    }))],
    ["saveStateUnsafeLegacyOrTest", await rejects(() => saveStateUnsafeLegacyOrTest(root, legacyState(stream)))],
  ];
  for (const [name, error] of attempts) {
    expect(error, `${name} did not refuse`).toBeInstanceOf(StateFormatTooNewError);
    expect((error as StateFormatTooNewError).file).toBe(statePath(root));
  }
  // Fail CLOSED, not merely fail: four refusals and not one byte moved.
  expect(rboxResidue(root)).toEqual(before);
});

// ---------------------------------------------------------------------------
// ROW 2 — candidate binary, LEGACY (pre-migration) workspace. Read it as before,
// and never convert it behind the user's back.

test("the candidate reads a legacy workspace exactly as before and leaves it byte-identical", async () => {
  const root = await legacyWorkspace("new-over-old");
  const config = configOf(root);
  const stream = syncStreamId(config);
  const before = rboxResidue(root);

  const state = await loadState(root, stream, () => undefined);
  expect(state.lastSyncedSequence).toBe(12);
  expect(state.lastSyncedManifest.files).toHaveLength(1);
  expect(state.gitReposRemoved).toEqual({ "gone/a": "identity-a" });
  expect(await loadRawState(root)).toBeDefined();
  expect((await checkState(root, config)).ok).toBeTrue();
  expect(checkStateGenesis(root).ok).toBeTrue();

  // Reading through the selecting seam and doctor never changes authority.
  expect(await classifyStateFormat(statePath(root))).toBe("json");
  expect(rboxResidue(root)).toEqual(before);
});

// ---------------------------------------------------------------------------
// ROW 3 — the `format-too-new` correction (222 §6.4 / 163 §C4).

/**
 * A HEALTHY migrated workspace must never be told "written by a newer version of
 * rbox — run `rbox upgrade`", because the binary reading it IS the newest one.
 *
 * 5B fixed this and 5B's own fixture encoded the WRONG verdict, so this checks
 * the real doctor surface over a really-migrated workspace rather than a planted
 * marker. The contradictory-authority row (a marker with no database) keeps its
 * own coverage in `doctor-triage.test.ts`; what is pinned here is the healthy
 * one, which is the case a real user hits after upgrading.
 */
test("a healthy SQLite workspace is never reported as a too-new format", async () => {
  const root = await sqliteWorkspace("format-too-new");
  const check = await checkState(root, configOf(root));

  expect(check.ok).toBeTrue();
  expect(check.status).toBe("sqlite");
  expect(check.status).not.toBe("format-too-new");
  const whole = `${check.message} ${check.hint ?? ""}`;
  expect(whole).not.toMatch(/newer version of rbox/i);
  expect(whole).not.toMatch(/rbox upgrade/i);
  expect(whole).not.toMatch(/delet/i);
  expect(checkStateGenesis(root).ok).toBeTrue();
});

// ---------------------------------------------------------------------------
// ROW 4 — the wire itself. These bytes are the ONLY thing two versions share.

test("the authority marker literal and byte length are the pinned cross-version wire", () => {
  expect(AUTHORITY_MARKER_MAGIC).toBe("RBOX-SQLITE-AUTHORITY-v1");
  expect(AUTHORITY_MARKER_BYTES).toBe(58);
  expect(AUTHORITY_MARKER_MAGIC.length + 1 + 32 + 1).toBe(AUTHORITY_MARKER_BYTES);

  const id = "0123456789abcdef0123456789abcdef";
  const bytes = authorityMarkerBytes(id);
  expect(bytes.byteLength).toBe(58);
  expect(bytes.toString("latin1")).toBe(`RBOX-SQLITE-AUTHORITY-v1\n${id}\n`);
  expect(isAuthorityMarkerBytes(bytes)).toBeTrue();

  // An id that is not exactly 32 lowercase hex is not composable at all: a
  // marker rbox cannot recognize is a marker rbox must never write.
  expect(() => authorityMarkerBytes(id.toUpperCase())).toThrow();
  expect(() => authorityMarkerBytes(`${id}0`)).toThrow();
});

test("the `Q` predicate accepts only this version's marker, and a future one is foreign", async () => {
  const root = await sqliteWorkspace("predicate");
  const bytes = await fsp.readFile(statePath(root));
  const id = await readAuthorityMarkerId(statePath(root));

  // What real genesis published is exactly what the composer composes.
  expect(bytes.byteLength).toBe(AUTHORITY_MARKER_BYTES);
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(bytes.equals(authorityMarkerBytes(id!))).toBeTrue();

  // The row that makes skew safe in the OTHER direction: a marker written by a
  // future rbox is `foreign`, never `authority-marker`, so this binary refuses
  // it instead of opening a database whose schema it does not know. Every near
  // miss is checked, because a lenient predicate is how a skew bug ships.
  const probe = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-u3-5c-compat-probe-"));
  const file = path.join(probe, "state.json");
  const cases: Array<[string, string]> = [
    ["future magic", `RBOX-SQLITE-AUTHORITY-v2\n${id}\n`],
    ["uppercase id", `${AUTHORITY_MARKER_MAGIC}\n${id!.toUpperCase()}\n`],
    ["missing trailing newline", `${AUTHORITY_MARKER_MAGIC}\n${id}0`],
    ["short id", `${AUTHORITY_MARKER_MAGIC}\n${id!.slice(1)}\n`],
    ["crlf", `${AUTHORITY_MARKER_MAGIC}\r\n${id!.slice(1)}\n`],
  ];
  for (const [label, body] of cases) {
    await fsp.writeFile(file, body, "latin1");
    expect(await classifyStateFormat(file), label).toBe("foreign");
  }
});
