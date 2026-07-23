import { expect, test } from "bun:test";
import { localFileObservationForScan } from "./push.js";

test("complete scans author warning truth while deferred scans preserve prior groups", () => {
  const prior = [{ paths: ["Lucky Meat.md", "Lucky meat.md"] }];

  expect(localFileObservationForScan(true, prior)).toEqual({ authority: "authoritative" });
  expect(localFileObservationForScan(false, prior)).toEqual({
    authority: "preserve",
    caseCollisions: prior,
  });
  expect(localFileObservationForScan(false)).toEqual({
    authority: "preserve",
    caseCollisions: [],
  });
});
