import { expect, test } from "bun:test";
import {
  DAEMON_HEARTBEAT_FUTURE_SKEW_MS,
  observeDaemon,
  type DaemonObservationDeps,
} from "./observation.js";
import { AMBIENT_STATUS_STALE_MS } from "./ambient-status.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const status = (over: Record<string, unknown> = {}) => ({
  kind: "ok" as const,
  status: {
    schemaVersion: 1 as const,
    daemonVersion: "2.0.0",
    mode: "read-write" as const,
    bootId: "boot-live",
    state: "synced" as const,
    heartbeatAt: new Date(NOW - 1_000).toISOString(),
    sequence: 3,
    lastSyncedAt: null,
    ...over,
  },
});

test("legacy ownership remains compatible but cannot trust boot-bound ambient state", () => {
  const observed = observedDaemon({
    pid: { present: true, pid: 42, version: "legacy" },
    binding: { present: true, workspaceId: "ws_live", version: "legacy" },
  });
  expect(observed.ownership).toBe("owned");
  expect(observed.ownsWorkspace).toBe(true);
  expect(observed.ambientTrust).toBe("pid-boot-unbound");
  expect(observed.trustedAmbient).toBeUndefined();
});

interface ObservationInput {
  pid: ReturnType<NonNullable<DaemonObservationDeps["readPid"]>>;
  binding: ReturnType<NonNullable<DaemonObservationDeps["readBinding"]>>;
  ambient: ReturnType<NonNullable<DaemonObservationDeps["readAmbient"]>>;
  processMatches: boolean;
  expectedWorkspaceId?: string;
  now: number;
}

const observationInput = (over: Partial<ObservationInput> = {}): ObservationInput => ({
  pid: { present: true, pid: 42, bootId: "boot-live", version: "v2" },
  binding: { present: true, workspaceId: "ws_live", bootId: "boot-live", version: "v2" },
  ambient: status(),
  processMatches: true,
  expectedWorkspaceId: "ws_live",
  now: NOW,
  ...over,
});

const observedDaemon = (over: Partial<ObservationInput> = {}) => {
  const input = observationInput(over);
  return observeDaemon("/workspace", input.expectedWorkspaceId, input.now, {
    readPid: () => input.pid,
    readBinding: () => input.binding,
    readAmbient: () => input.ambient,
    processMatches: () => input.processMatches,
  });
};

test("PID and binding record formats use one explicit compatibility matrix", () => {
  const rows = [
    {
      name: "legacy/legacy remains owned",
      pid: { present: true, pid: 42, version: "legacy" as const },
      binding: { present: true, workspaceId: "ws_live", version: "legacy" as const },
      ownership: "owned",
    },
    {
      name: "v2/v2 with one boot remains owned",
      pid: { present: true, pid: 42, bootId: "boot-live", version: "v2" as const },
      binding: { present: true, workspaceId: "ws_live", bootId: "boot-live", version: "v2" as const },
      ownership: "owned",
    },
    {
      name: "v2 PID with legacy binding fails closed",
      pid: { present: true, pid: 42, bootId: "boot-live", version: "v2" as const },
      binding: { present: true, workspaceId: "ws_live", version: "legacy" as const },
      ownership: "record-format-mismatch",
    },
    {
      name: "legacy PID with v2 binding fails closed",
      pid: { present: true, pid: 42, version: "legacy" as const },
      binding: { present: true, workspaceId: "ws_live", bootId: "boot-live", version: "v2" as const },
      ownership: "record-format-mismatch",
    },
  ] as const;

  for (const row of rows) {
    const observed = observedDaemon({
      pid: row.pid,
      binding: row.binding,
      ambient: { kind: "absent" },
    });
    expect(`${row.name}:${observed.ownership}`).toBe(`${row.name}:${row.ownership}`);
    expect(observed.ownsWorkspace).toBe(row.ownership === "owned");
  }
});

test("one closed observation proves process, binding, boot, freshness, version, and mode", () => {
  expect(observedDaemon()).toMatchObject({
    ownership: "owned",
    running: true,
    pid: 42,
    bootId: "boot-live",
    boundWorkspaceId: "ws_live",
    stale: false,
    ownsWorkspace: true,
    ambientTrust: "trusted",
    version: "2.0.0",
    mode: "read-write",
  });
});

test("process and binding failures cannot lend trust to daemon sidecars", () => {
  const rows: Array<[string, Partial<ObservationInput>, string, boolean]> = [
    ["dead/reused pid", { processMatches: false }, "stopped", false],
    ["missing pid", { pid: { present: false } }, "stopped", false],
    ["missing binding", { binding: { present: false } }, "unbound", false],
    ["wrong workspace", { binding: { present: true, workspaceId: "ws_old", version: "legacy" } }, "wrong-workspace", true],
    ["v2 pid with legacy binding", {
      binding: { present: true, workspaceId: "ws_live", version: "legacy" },
    }, "record-format-mismatch", false],
    ["legacy pid with v2 binding", {
      pid: { present: true, pid: 42, version: "legacy" },
    }, "record-format-mismatch", false],
    ["binding from another boot", {
      binding: { present: true, workspaceId: "ws_live", bootId: "boot-old", version: "v2" },
    }, "binding-boot-mismatch", false],
  ];
  for (const [name, over, ownership, stale] of rows) {
    const observed = observedDaemon(over);
    expect(`${name}:${observed.ownership}:${observed.stale}`).toBe(`${name}:${ownership}:${stale}`);
    expect(observed.ownsWorkspace).toBe(false);
    expect(observed.trustedAmbient).toBeUndefined();
  }
});

test("ambient trust rejects every unsupported incarnation and clock state", () => {
  const rows: Array<[string, ObservationInput["ambient"]]> = [
    ["absent", { kind: "absent" }],
    ["corrupt", { kind: "corrupt" }],
    ["ambient-boot-unbound", status({ bootId: undefined })],
    ["boot-mismatch", status({ bootId: "boot-old" })],
    ["stale", status({ heartbeatAt: new Date(NOW - AMBIENT_STATUS_STALE_MS - 1).toISOString() })],
    ["future", status({ heartbeatAt: new Date(NOW + DAEMON_HEARTBEAT_FUTURE_SKEW_MS + 1).toISOString() })],
  ];
  for (const [trust, ambient] of rows) {
    const observed = observedDaemon({ ambient });
    expect(observed.ambientTrust).toBe(trust);
    expect(observed.trustedAmbient).toBeUndefined();
    expect(observed.version).toBeUndefined();
    expect(observed.mode).toBeUndefined();
  }
});
