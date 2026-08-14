import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  beginFirstPublishTiming,
  firstPublishUploadEnd,
  firstPublishUploadStart,
  intervalUnionOverlapMs,
  uploadActiveOverlapMs,
} from "./upload-lane-timing.js";
import { enterPushSpansForTest, type FirstPublishTiming } from "./push-spans.js";

let firstPublishTiming: FirstPublishTiming;
beforeEach(() => { firstPublishTiming = enterPushSpansForTest().firstPublish; });
afterEach(() => beginFirstPublishTiming(false));

test("intervalUnionOverlapMs intersects a drain with the upload interval union", () => {
  const intervals = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
  expect(intervalUnionOverlapMs(12, 18, intervals)).toBe(6);
  expect(intervalUnionOverlapMs(5, 15, intervals)).toBe(5);
  expect(intervalUnionOverlapMs(21, 29, intervals)).toBe(0);
  expect(intervalUnionOverlapMs(5, 35, intervals)).toBe(15);
  expect(intervalUnionOverlapMs(5, 35, [])).toBe(0);
  expect(intervalUnionOverlapMs(15, 15, intervals)).toBe(0);
});

test("nested upload activity produces one closed union interval", () => {
  beginFirstPublishTiming(true);
  firstPublishUploadStart();
  firstPublishUploadStart();
  firstPublishUploadEnd();
  expect(firstPublishTiming.uploadIntervals).toEqual([]);
  expect(firstPublishTiming.uploadActive).toBe(1);
  firstPublishUploadEnd();
  expect(firstPublishTiming.uploadIntervals).toHaveLength(1);
  expect(firstPublishTiming.uploadActive).toBe(0);
  expect(firstPublishTiming.uploadOpenAt).toBe(0);
});

test("sequential upload activity produces two intervals and extra ends are inert", () => {
  beginFirstPublishTiming(true);
  firstPublishUploadStart();
  firstPublishUploadEnd();
  firstPublishUploadStart();
  firstPublishUploadEnd();
  expect(firstPublishTiming.uploadIntervals).toHaveLength(2);
  firstPublishUploadEnd();
  expect(firstPublishTiming.uploadIntervals).toHaveLength(2);
  expect(firstPublishTiming.uploadActive).toBe(0);
  expect(firstPublishTiming.uploadOpenAt).toBe(0);
});

test("uploadActiveOverlapMs includes the currently open upload interval", async () => {
  beginFirstPublishTiming(true);
  firstPublishUploadStart();
  const t0 = performance.now();
  await Bun.sleep(5);
  const t1 = performance.now();
  expect(uploadActiveOverlapMs(t0, t1)).toBeCloseTo(t1 - t0, 5);
});

test("uploadActiveOverlapMs sums closed intervals and the open interval without double credit", () => {
  beginFirstPublishTiming(true);
  firstPublishTiming.uploadIntervals = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
  firstPublishTiming.uploadOpenAt = 50; // an upload is still in flight
  // Window [15, 60]: closed parts are [15,20] (5) + [30,40] (10); open part is [50,60] (10).
  expect(uploadActiveOverlapMs(15, 60)).toBe(25);
  // Window entirely before the open interval takes no open-interval credit.
  expect(uploadActiveOverlapMs(15, 45)).toBe(15);
});
