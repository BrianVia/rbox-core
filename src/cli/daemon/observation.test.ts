import { expect, test } from "bun:test";
import {
  DAEMON_HEARTBEAT_FUTURE_SKEW_MS,
  observeDaemon,
  type DaemonObservationDeps,
} from "./observation.js";
import { AMBIENT_STATUS_STALE_MS } from "./ambient-status.js";
import type { AmbientDaemonStatusV1 } from "./ambient-status.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const status = (over: Partial<AmbientDaemonStatusV1> = {}) => ({
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
  expect(observedDaemon({ ambient: status({ watcherTrust: "fused" }) })).toMatchObject({
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
    trustedAmbient: { watcherTrust: "fused" },
  });
});

test("process and binding failures cannot lend trust to daemon sidecars", () => {
  // `ownsRoot` is the base-compatible attribution gate: only a DEAD daemon or an
  // explicitly foreign binding withholds a live daemon's own records. Startup and
  // mixed-format bindings stay readable, and only `ownsWorkspace` narrows to a
  // proven binding.
  const rows: Array<[string, Partial<ObservationInput>, string, boolean, boolean]> = [
    ["dead/reused pid", { processMatches: false }, "stopped", false, false],
    ["missing pid", { pid: { present: false } }, "stopped", false, false],
    ["missing binding", { binding: { present: false } }, "unbound", false, true],
    ["wrong workspace", { binding: { present: true, workspaceId: "ws_old", version: "legacy" } }, "wrong-workspace", true, false],
    ["v2 pid with legacy binding", {
      binding: { present: true, workspaceId: "ws_live", version: "legacy" },
    }, "record-format-mismatch", false, true],
    ["legacy pid with v2 binding", {
      pid: { present: true, pid: 42, version: "legacy" },
    }, "record-format-mismatch", false, true],
  ];
  for (const [name, over, ownership, stale, ownsRoot] of rows) {
    const observed = observedDaemon(over);
    expect(`${name}:${observed.ownership}:${observed.stale}`).toBe(`${name}:${ownership}:${stale}`);
    expect(`${name}:${observed.ownsRoot}`).toBe(`${name}:${ownsRoot}`);
    expect(observed.ownsWorkspace).toBe(false);
  }
});

test("a live daemon still in startup keeps its ambient record trustworthy", () => {
  // `rbox start` clears the binding before spawning; the child rewrites it only
  // after loading its hash cache. Its own status record stays evidence.
  const starting = observedDaemon({ binding: { present: false } });
  expect(starting.ownership).toBe("unbound");
  expect(starting.ownsRoot).toBe(true);
  expect(starting.ownsWorkspace).toBe(false);
  expect(starting.ambientTrust).toBe("trusted");
  expect(starting.trustedAmbient?.bootId).toBe("boot-live");

  const foreign = observedDaemon({ binding: { present: true, workspaceId: "ws_old", version: "legacy" } });
  expect(foreign.ownsRoot).toBe(false);
  expect(foreign.ambientTrust).toBe("binding-untrusted");
  expect(foreign.trustedAmbient).toBeUndefined();
});

test("binding boot metadata cannot override the pidfile incarnation", () => {
  const observed = observedDaemon({
    binding: { present: true, workspaceId: "ws_live", bootId: "boot-loser", version: "v2" },
  });

  expect(observed.ownership).toBe("owned");
  expect(observed.ownsWorkspace).toBe(true);
  expect(observed.bootId).toBe("boot-live");
  expect(observed.ambientTrust).toBe("trusted");
  expect(observed.trustedAmbient?.bootId).toBe("boot-live");
});

test("sidecar binding attribution survives daemon exit without broadening trust", () => {
  const rows = [
    [{ present: false }, "absent"],
    [{ present: true, workspaceId: "ws_live", version: "legacy" }, "workspace"],
    [{ present: true, workspaceId: "ws_other", version: "legacy" }, "other-workspace"],
    [{ present: true, unreadable: true }, "unreadable"],
  ] as const;
  for (const [binding, expected] of rows) {
    const observed = observedDaemon({ pid: { present: false }, binding });
    expect(observed.running).toBe(false);
    expect(observed.sidecarBinding).toBe(expected);
  }
});

test("ambient trust rejects every unsupported incarnation and clock state", () => {
  const rows: Array<[string, ObservationInput["ambient"]]> = [
    ["absent", { kind: "absent" }],
    ["corrupt", { kind: "corrupt" }],
    ["ambient-boot-unbound", status({ bootId: undefined })],
    ["boot-mismatch", status({ bootId: "boot-old" })],
    ["stale", status({ heartbeatAt: new Date(NOW - AMBIENT_STATUS_STALE_MS - 1).toISOString(), watcherTrust: "fused" })],
    ["future", status({ heartbeatAt: new Date(NOW + DAEMON_HEARTBEAT_FUTURE_SKEW_MS + 1).toISOString() })],
  ];
  for (const [trust, ambient] of rows) {
    const observed = observedDaemon({ ambient });
    expect(observed.ambientTrust).toBe(trust);
    expect(observed.trustedAmbient).toBeUndefined();
    expect(observed.mode).toBeUndefined();
  }
});

test("a live daemon's version survives every trust failure that is not about the version", () => {
  // The upgrade nudge exists FOR old daemons: the states that lose boot-id or
  // heartbeat trust are exactly the ones a pre-178 or wedged daemon is in.
  const rows: Array<[string, Partial<ObservationInput>]> = [
    ["boot-mismatch", { ambient: status({ bootId: "boot-old" }) }],
    ["ambient-boot-unbound", { ambient: status({ bootId: undefined }) }],
    ["pid-boot-unbound", {
      pid: { present: true, pid: 42, version: "legacy" },
      binding: { present: true, workspaceId: "ws_live", version: "legacy" },
    }],
    ["unbound", { binding: { present: false } }],
    ["stale heartbeat", { ambient: status({ heartbeatAt: new Date(NOW - AMBIENT_STATUS_STALE_MS - 1).toISOString() }) }],
  ];
  for (const [name, over] of rows) {
    const observed = observedDaemon(over);
    expect(`${name}:${observed.version}`).toBe(`${name}:2.0.0`);
  }

  // A dead daemon, a foreign binding, and an unparsable version claim nothing.
  expect(observedDaemon({ processMatches: false }).version).toBeUndefined();
  expect(observedDaemon({ binding: { present: true, workspaceId: "ws_old", version: "legacy" } }).version).toBeUndefined();
  expect(observedDaemon({ ambient: { kind: "corrupt" } }).version).toBeUndefined();
  expect(observedDaemon({ ambient: status({ daemonVersion: "not a version" }) }).version).toBeUndefined();
});
