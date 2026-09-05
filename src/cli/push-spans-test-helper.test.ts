import { expect, test as bunTest } from "bun:test";
import { currentFirstPublishTiming } from "./push-spans.js";
import { pushSpanTests } from "./push-spans.test-helper.js";
import { beginFirstPublishTiming } from "./upload-lane-timing.js";

const test = pushSpanTests(bunTest);

test("statistics fixture binds the supplied owner through the callback's async continuations", async (timing) => {
  expect(currentFirstPublishTiming()).toBe(timing);
  expect(timing.enabled).toBe(false);
  beginFirstPublishTiming(true);
  await Promise.resolve();
  expect(currentFirstPublishTiming()).toBe(timing);
  expect(timing.enabled).toBe(true);
});

test("each statistics fixture starts with its own disabled measurement", async (timing) => {
  expect(currentFirstPublishTiming()).toBe(timing);
  expect(timing.enabled).toBe(false);
  await Promise.resolve();
  expect(currentFirstPublishTiming()).toBe(timing);
});
