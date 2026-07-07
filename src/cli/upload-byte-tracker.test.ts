import { expect, test } from "bun:test";
import { UploadByteTracker } from "./upload-byte-tracker.js";

const p = (t: UploadByteTracker) => t.progress();

test("upload byte tracker set/migrate/defer/revise preserves bytesDone <= bytesTotal", () => {
  const t = UploadByteTracker.fromFiles([{ path: "a", encSha: "old" }], new Set(["old"]));
  expect(p(t)).toEqual({ bytesDone: 0, bytesTotal: 0 });

  t.setProgress("old", 20); // absolute progress before the denominator is known is remembered, not accounted
  expect(p(t)).toEqual({ bytesDone: 0, bytesTotal: 0 });

  t.reviseTotal("old", 100);
  expect(p(t)).toEqual({ bytesDone: 20, bytesTotal: 100 });

  t.migrate("a", "new", 80);
  expect(p(t)).toEqual({ bytesDone: 0, bytesTotal: 80 });

  t.setProgress("new", 80);
  expect(p(t)).toEqual({ bytesDone: 80, bytesTotal: 80 });

  t.defer("a");
  expect(p(t)).toEqual({ bytesDone: 0, bytesTotal: 0 });
});

test("migration retracts old credit only when no live file still owns the old encSha", () => {
  const t = UploadByteTracker.fromFiles(
    [
      { path: "a", encSha: "old" },
      { path: "b", encSha: "old" },
    ],
    new Set(["old"]),
    new Map([["old", 100]])
  );
  t.setProgress("old", 70);
  expect(p(t)).toEqual({ bytesDone: 70, bytesTotal: 100 });

  t.migrate("a", "new", 50);
  expect(p(t)).toEqual({ bytesDone: 70, bytesTotal: 150 });

  t.setProgress("new", 25);
  expect(p(t)).toEqual({ bytesDone: 95, bytesTotal: 150 });

  t.defer("a");
  expect(p(t)).toEqual({ bytesDone: 70, bytesTotal: 100 });

  t.defer("b");
  expect(p(t)).toEqual({ bytesDone: 0, bytesTotal: 0 });
});

test("64-way simulated upload interleaving never violates the byte invariant", () => {
  const owners = Array.from({ length: 64 }, (_, i) => ({ path: `f${i}`, encSha: `e${i}` }));
  const missing = new Set(owners.map((o) => o.encSha!));
  const planned = new Map(owners.map((o, i) => [o.encSha!, 100 + i]));
  const t = UploadByteTracker.fromFiles(owners, missing, planned);

  const check = () => {
    const { bytesDone, bytesTotal } = p(t);
    expect(bytesDone).toBeGreaterThanOrEqual(0);
    expect(bytesTotal).toBeGreaterThanOrEqual(0);
    expect(bytesDone).toBeLessThanOrEqual(bytesTotal);
  };

  for (let i = 63; i >= 0; i--) {
    t.setProgress(`e${i}`, Math.floor((100 + i) / 2));
    check();
    if (i % 3 === 0) {
      t.migrate(`f${i}`, `n${i}`, 80 + i);
      check();
      t.setProgress(`n${i}`, 40 + i);
      check();
    }
    if (i % 5 === 0) {
      t.defer(`f${i}`);
      check();
    }
    if (i % 7 === 0) {
      t.reviseTotal(`e${i}`, 120 + i);
      check();
    }
  }
});
