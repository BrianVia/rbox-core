import { expect, test } from "bun:test";
import type { Manifest } from "../engine/index.js";
import { E2eeRemote } from "./e2ee-remote.js";
import type { E2eeApi, E2eeContext, PinStore } from "./e2ee-remote-types.js";

// #818 fix 3: `commit()` used to pay the whole GET /v1/keys/account round-trip
// serially in front of the signature. `prefetchAccount()` issues it early so it
// overlaps the upload — WITHOUT weakening C4 or losing the error.

const EMPTY: Manifest = { generatedAt: "", files: [] };

function remoteWith(keys: () => Promise<never>, now = () => 1_000_000) {
  let calls = 0;
  const used: Pick<E2eeApi, "getAccountKeys"> = {
    getAccountKeys: () => {
      calls++;
      return keys();
    },
  };
  const api = used as E2eeApi; // commit()'s account read is the only member this exercises
  const remote = new E2eeRemote(
    api,
    { accountId: "a", workspaceId: "w", secrets: {} as never, now } as E2eeContext,
    { load: async () => undefined, save: async () => {} } satisfies PinStore,
  );
  return { remote, calls: () => calls };
}

const boom = async (): Promise<never> => {
  throw new Error("keys GET failed");
};

test("prefetchAccount issues the keys GET immediately, and commit consumes it instead of re-issuing", async () => {
  const { remote, calls } = remoteWith(boom);

  remote.prefetchAccount();
  expect(calls()).toBe(1); // in flight before the caller's next await (the upload)

  await expect(remote.commit(0, "device", EMPTY)).rejects.toThrow("keys GET failed");
  expect(calls()).toBe(1); // the parked read was reused, not repeated
});

test("a rejected prefetch still fails the push with the same error, and never as an unhandled rejection", async () => {
  const { remote, calls } = remoteWith(boom);
  const unhandled: unknown[] = [];
  const onUnhandled: NodeJS.UnhandledRejectionListener = (reason) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    remote.prefetchAccount();
    // Let the rejection settle with no consumer attached yet — the fire-and-forget hazard.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(unhandled).toEqual([]);
    await expect(remote.commit(0, "device", EMPTY)).rejects.toThrow("keys GET failed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(calls()).toBe(1);
});

test("an abandoned push's stale prefetch is never signed against — C4 gets a fresh read", async () => {
  let clock = 1_000_000;
  const { remote, calls } = remoteWith(boom, () => clock);

  remote.prefetchAccount(); // a push that then bailed out before commit
  expect(calls()).toBe(1);
  clock += 61_000;

  await expect(remote.commit(0, "device", EMPTY)).rejects.toThrow("keys GET failed");
  expect(calls()).toBe(2); // stale one discarded, refreshed immediately before signing
});

test("without a prefetch commit reads the account exactly as before", async () => {
  const { remote, calls } = remoteWith(boom);
  await expect(remote.commit(0, "device", EMPTY)).rejects.toThrow("keys GET failed");
  expect(calls()).toBe(1);
});
