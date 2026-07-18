import { expect, test } from "bun:test";
import { progressLabel } from "./status-view.js";

test("422 reupload retry renders a fresh raw 0/N instead of stale 100%", () => {
  expect(progressLabel("upload", 1, 1, undefined, { bytesDone: 100, bytesTotal: 100 })).toBe("uploading ▓▓▓▓▓ 100% · 100 B / 100 B");
  expect(progressLabel("upload", 0, 1, undefined, { bytesDone: 0, bytesTotal: 100 })).toBe("uploading ░░░░░ 0% · 0 B / 100 B");
});
