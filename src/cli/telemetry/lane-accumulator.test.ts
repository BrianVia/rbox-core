import { expect, test } from "bun:test";
import { recordLaneSettlement, withPushLaneAccumulator } from "./lane-accumulator.js";

test("lane settlements are request-counted and reset unconditionally between push scopes", async () => {
  const priorFill = process.env.RBOX_BATCH_FILL;
  process.env.RBOX_BATCH_FILL = "v2";
  const emitted: unknown[][] = [];
  await withPushLaneAccumulator(async () => {
    recordLaneSettlement("batch", 10, 2.4);
    recordLaneSettlement("batch", 20, 3.6);
    recordLaneSettlement("single", 5, 1);
  }, (samples) => emitted.push(samples));
  expect(emitted[0]).toEqual([
    { kind: "upload_lane", transport: "batch", fillVersion: "v2", bytes: 30, uploadMs: 6, opCount: 2 },
    { kind: "upload_lane", transport: "single", fillVersion: "v2", bytes: 5, uploadMs: 1, opCount: 1 },
  ]);
  await expect(withPushLaneAccumulator(async () => { throw new Error("boom"); }, (samples) => emitted.push(samples))).rejects.toThrow("boom");
  expect(emitted[1]).toEqual([]);
  await expect(withPushLaneAccumulator(async () => "ok", () => { throw new Error("telemetry"); })).resolves.toBe("ok");
  if (priorFill === undefined) delete process.env.RBOX_BATCH_FILL;
  else process.env.RBOX_BATCH_FILL = priorFill;
});
