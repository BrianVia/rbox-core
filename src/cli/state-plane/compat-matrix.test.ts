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
 * that vintage runs, on a workspace built by the REAL migration, and the
 * zero-mutation half is measured with `rboxResidue` over the whole `.rbox` tree
 * rather than asserted about one file.
 *
 * NOT PROVABLE HERE — see `dual-binary rig` at the bottom.
 */
import { expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkState, checkStateMigration } from "../doctor-state-plane.js";
import { migrateCmd } from "../state-plane-cmd.js";
import {
  type SyncState,
} from "../sync-state-model.js";
import {
  repoRecordsForState, stateFromRepoRecords,
} from "../sync-state-records.js";
import { saveStateUnsafeLegacyOrTest } from "../sync-state-store.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import {
  AUTHORITY_MARKER_BYTES, AUTHORITY_MARKER_MAGIC, authorityMarkerBytes,
  classifyStateFormat, isAuthorityMarkerBytes, readAuthorityMarkerId,
} from "./authority-marker.js";
import { loadRawState, loadState } from "./adapters/whole-state-compat.js";
import {
  applyLegacyJsonSavePacket, loadLegacyJsonState, loadRawLegacyJsonState,
} from "./adapters/legacy-json-store.js";
import { StateFormatTooNewError } from "./errors.js";
import { rboxResidue } from "./migration/fault-rig.js";
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

/** …and the same workspace after the REAL `rbox migrate`. Nothing here writes a
 * post-migration byte by hand. */
async function migratedWorkspace(prefix: string): Promise<string> {
  const root = await legacyWorkspace(prefix);
  const lines: string[] = [];
  expect(await migrateCmd(root, { log: (line) => lines.push(line) }), lines.join(" ")).toBe(0);
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
test("an old binary's every state read and write over a migrated workspace fails closed", async () => {
  const root = await migratedWorkspace("old-over-new");
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
  expect(checkStateMigration(root).ok).toBeTrue();

  // 222's "parked car": conversion is explicit and exclusive. Merely reading —
  // including through the SELECTING seam and through doctor — neither migrates
  // nor touches anything.
  expect(await classifyStateFormat(statePath(root))).toBe("json");
  expect(rboxResidue(root)).toEqual(before);
});

/**
 * §6.1's `barrier-witness-missing`: a legacy workspace whose last-writer witness
 * is absent is one the candidate may still READ, but may not convert — it cannot
 * prove no older binary is still writing the document. The refusal must be typed
 * copy with an exit code, and must leave the workspace untouched and legacy.
 */
test("the candidate refuses to migrate a legacy workspace with no last-writer witness", async () => {
  const root = await legacyWorkspace("witness-missing");
  await fsp.rm(path.join(sqliteResetPaths.stateRoot(root), "last-writer.json"));
  const before = rboxResidue(root);

  const lines: string[] = [];
  const code = await migrateCmd(root, { log: (line) => lines.push(line) });

  expect(code).toBe(1);
  expect(lines.join(" ")).not.toContain("Error:");
  expect(lines.some((line) => line.startsWith("Next: "))).toBeTrue();
  // The machine identity, not merely a non-zero exit: exit 1 plus a `Next:` line
  // is also what a dozen unrelated refusals produce.
  const json: string[] = [];
  expect(await migrateCmd(root, { json: true, log: (line) => json.push(line) })).toBe(1);
  expect(JSON.parse(json.join("\n")).outcome).toBe("refused:barrier-witness-missing");
  expect(await classifyStateFormat(statePath(root))).toBe("json");
  expect(rboxResidue(root)).toEqual(before);
  // Still fully readable by the candidate afterwards — a refusal is not damage.
  expect((await loadState(root, syncStreamId(configOf(root)), () => undefined)).lastSyncedSequence).toBe(12);
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
test("a healthy migrated workspace is never reported as a too-new format", async () => {
  const root = await migratedWorkspace("format-too-new");
  const check = await checkState(root, configOf(root));

  expect(check.ok).toBeTrue();
  expect(check.status).toBe("sqlite");
  expect(check.status).not.toBe("format-too-new");
  const whole = `${check.message} ${check.hint ?? ""}`;
  expect(whole).not.toMatch(/newer version of rbox/i);
  expect(whole).not.toMatch(/rbox upgrade/i);
  expect(whole).not.toMatch(/delet/i);
  expect(checkStateMigration(root).ok).toBeTrue();

  // `rbox migrate` on its own finished work says so, and does not raise the
  // barrier at the user either (the 222 §3.2 re-entry debt).
  const again: string[] = [];
  expect(await migrateCmd(root, { log: (line) => again.push(line) })).toBe(0);
  expect(again.join(" ")).not.toMatch(/newer version of rbox|StateFormatTooNew/);
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
  const root = await migratedWorkspace("predicate");
  const bytes = await fsp.readFile(statePath(root));
  const id = await readAuthorityMarkerId(statePath(root));

  // What the real migration published is exactly what the composer composes.
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

// ---------------------------------------------------------------------------
// ROW 5 — the released dual-binary rig is a required registered gate.

/**
 * The unit process cannot impersonate a released executable. Its MUST is the
 * structural half: keep a distinct-binary scenario registered, pin 1.11.4, and
 * name all three negative probes. The rig supplies the executable identities,
 * hashes, versions, real operations, and byte-equality assertions.
 */
test("dual-binary rig is a registered 1.11.4 compatibility MUST", async () => {
  // Structural, not textual: source text can carry every one of these strings in
  // a comment while the scenario the runner actually loads has drifted. These are
  // the values the rig runs on.
  const [scenario, registry] = await Promise.all([
    import("../../../scripts/rig/scenarios/dual-binary-state.js"),
    import("../../../scripts/rig/scenarios/index.js"),
  ]);
  expect(scenario.PINNED_RELEASED_VERSION).toBe("1.11.4");
  expect([...scenario.RELEASED_NEGATIVE_PROBES]).toEqual(["status", "sync", "doctor"]);
  expect(scenario.dualBinaryState.supportsDualBinary).toBe(true);
  expect(scenario.dualBinaryState.name).toBe("dual-binary-state");
  // Registered under its own name, so `rig dual-binary-state` reaches this object.
  expect(registry.getScenario("dual-binary-state")).toBe(scenario.dualBinaryState);
});
