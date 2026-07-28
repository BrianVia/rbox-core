import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RBOX_TMP_PREFIX } from "../../../engine/fsutil.js";
import {
  buildReserveHeader,
  ensureStateReserve,
  inspectStateReserve,
  parseReserveHeader,
  RESERVE_FILL_BYTES,
  RESERVE_HEADER_BYTES,
  RESERVE_MAGIC,
  RESERVE_MAX_VERSION_BYTES,
  RESERVE_TOTAL_BYTES,
  stateReservePath,
  streamDigest,
} from "./reserve.js";
import { applyStateSavePacket } from "../../sync-state-store.js";

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  return root;
}

async function expectReserveCreationFaultToSelfHeal(
  step: "header-written" | "fill-written" | "temp-synced",
): Promise<void> {
  const root = await workspace(`rbox-reserve-fault-${step}-`);
  const failed = await ensureStateReserve(root, "stream", "1.11.0", {
    onStep: (observed) => {
      if (observed === step) throw new Error(`injected-${step}`);
    },
  });
  expect(failed.status).toBe("unavailable");
  await expect(fs.lstat(stateReservePath(root))).rejects.toThrow();
  expect((await fs.readdir(path.dirname(stateReservePath(root))))
    .filter((name) => name.startsWith(RBOX_TMP_PREFIX))).toEqual([]);

  expect((await ensureStateReserve(root, "stream", "1.11.0")).status).toBe("created");
  expect((await inspectStateReserve(root, "stream")).status).toBe("adopted");
}

test("the reserve header arithmetic closes at exactly 1 MiB", () => {
  expect(RESERVE_MAGIC.length).toBe(21);
  expect(RESERVE_HEADER_BYTES + RESERVE_FILL_BYTES).toBe(RESERVE_TOTAL_BYTES);
  expect(RESERVE_FILL_BYTES).toBe(1_048_448);
  expect(RESERVE_TOTAL_BYTES).toBe(1_048_576);
  expect(RESERVE_MAX_VERSION_BYTES).toBe(40);

  const digest = streamDigest("stream");
  const header = buildReserveHeader("1.11.0-rc.3+2026072701", digest);
  expect(header.byteLength).toBe(RESERVE_HEADER_BYTES);
  expect(parseReserveHeader(header)).toEqual({ creatingVersion: "1.11.0-rc.3+2026072701", streamSha256: digest });
  expect(() => buildReserveHeader("v".repeat(41), digest)).toThrow();
  expect(parseReserveHeader(Buffer.concat([header.subarray(0, 127), Buffer.from([0x41])]))).toBeUndefined();
});

test("the reserve is created once at exactly 1 MiB and then adopted", async () => {
  const root = await workspace("rbox-reserve-");
  const created = await ensureStateReserve(root, "stream");
  expect(created.status).toBe("created");
  const stat = await fs.stat(stateReservePath(root));
  expect(stat.size).toBe(RESERVE_TOTAL_BYTES);
  const bytes = await fs.readFile(stateReservePath(root));
  expect(parseReserveHeader(bytes.subarray(0, RESERVE_HEADER_BYTES))?.streamSha256).toBe(streamDigest("stream"));
  expect(bytes.subarray(RESERVE_HEADER_BYTES).every((byte) => byte === 0)).toBe(true);
  expect((await ensureStateReserve(root, "stream")).status).toBe("adopted");
});

test("a reserve fault after the header write self-heals on the next attempt", async () => {
  await expectReserveCreationFaultToSelfHeal("header-written");
});

test("a reserve fault after the fill write self-heals on the next attempt", async () => {
  await expectReserveCreationFaultToSelfHeal("fill-written");
});

test("a reserve fault after the temp fsync self-heals on the next attempt", async () => {
  await expectReserveCreationFaultToSelfHeal("temp-synced");
});

test("a reserve final-name collision classifies the winner and leaves no temp", async () => {
  const root = await workspace("rbox-reserve-claim-collision-");
  const digest = streamDigest("stream");
  const winner = Buffer.concat([buildReserveHeader("1.11.0", digest), Buffer.alloc(RESERVE_FILL_BYTES)]);

  const raced = await ensureStateReserve(root, "stream", "1.11.0", {
    onStep: async (step) => {
      if (step === "before-final-claim") await fs.writeFile(stateReservePath(root), winner);
    },
  });

  expect(raced.status).toBe("adopted");
  expect(await fs.readFile(stateReservePath(root))).toEqual(winner);
  expect((await fs.readdir(path.dirname(stateReservePath(root))))
    .filter((name) => name.startsWith(RBOX_TMP_PREFIX))).toEqual([]);
  expect((await ensureStateReserve(root, "stream", "1.11.0")).status).toBe("adopted");
});

test("a foreign reserve is never adopted, truncated, or deleted", async () => {
  const cases: Array<[string, Buffer | "dir", string]> = [
    ["wrong-size", Buffer.alloc(64), "wrong-size"],
    ["header-malformed", Buffer.concat([Buffer.from("NOT-A-RESERVE\n"), Buffer.alloc(RESERVE_TOTAL_BYTES - 14)]), "header-malformed"],
    ["foreign-workspace", Buffer.concat([buildReserveHeader("1.11.0", streamDigest("someone-else")), Buffer.alloc(RESERVE_FILL_BYTES)]), "foreign-workspace"],
    ["not-a-regular-file", "dir", "not-a-regular-file"],
  ];
  for (const [name, content, detail] of cases) {
    const root = await workspace(`rbox-reserve-foreign-${name}-`);
    const file = stateReservePath(root);
    if (content === "dir") await fs.mkdir(file, { recursive: true });
    else await fs.writeFile(file, content);
    const before = content === "dir" ? undefined : await fs.readFile(file);
    expect(await ensureStateReserve(root, "stream")).toEqual({ status: "reserve-foreign", detail: detail as never });
    expect(await inspectStateReserve(root, "stream")).toEqual({ status: "reserve-foreign", detail: detail as never });
    const after = content === "dir" ? undefined : await fs.readFile(file);
    expect(after).toEqual(before);
    if (content === "dir") expect((await fs.lstat(file)).isDirectory()).toBe(true);
  }
});

test("a symlink at the reserve path is foreign and its target is left alone", async () => {
  const root = await workspace("rbox-reserve-symlink-");
  const target = path.join(root, "victim.bin");
  await fs.writeFile(target, Buffer.concat([buildReserveHeader("1.11.0", streamDigest("stream")), Buffer.alloc(RESERVE_FILL_BYTES)]));
  const before = await fs.readFile(target);
  await fs.symlink(target, stateReservePath(root));

  // The header behind the link is valid and names this very workspace: only the
  // no-follow lookup keeps it from being adopted, claimed, and later deleted.
  expect(await ensureStateReserve(root, "stream")).toEqual({ status: "reserve-foreign", detail: "not-a-regular-file" });
  expect((await fs.lstat(stateReservePath(root))).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(target)).toEqual(before);
});

test("a header whose version field is not a semver is malformed, not adopted", async () => {
  const digest = streamDigest("stream");
  const forged = Buffer.alloc(RESERVE_HEADER_BYTES);
  forged.write(`${RESERVE_MAGIC} !!!!!!!! ${digest}\n`, 0, "latin1");
  expect(parseReserveHeader(forged)).toBeUndefined();

  const root = await workspace("rbox-reserve-badsemver-");
  await fs.writeFile(stateReservePath(root), Buffer.concat([forged, Buffer.alloc(RESERVE_FILL_BYTES)]));
  expect(await ensureStateReserve(root, "stream")).toEqual({ status: "reserve-foreign", detail: "header-malformed" });
});

test("a state save leaves a reserve behind for a future upgrade", async () => {
  const root = await workspace("rbox-reserve-after-save-");
  const result = await applyStateSavePacket(root, {
    expectedStream: "stream", expectedNonce: "legacy", sourceGlobalSeq: 0, repos: [],
  });
  expect(result.status).toBe("accepted");
  expect((await fs.stat(stateReservePath(root))).size).toBe(RESERVE_TOTAL_BYTES);
});
