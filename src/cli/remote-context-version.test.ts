import { expect, test } from "bun:test";
import { RemoteContext } from "./remote/context.js";
import { RBOX_VERSION } from "./version.js";

test("RemoteContext includes the running version in every shared auth header", () => {
  const ctx = new RemoteContext("https://api.test", "token", "workspace", "project");

  expect(ctx.auth).toEqual({ authorization: "Bearer token", "x-rbox-version": RBOX_VERSION });
  expect(ctx.protoAuth).toEqual({
    authorization: "Bearer token",
    "x-rbox-version": RBOX_VERSION,
    "x-rbox-protocol": "upload-receipts-v1",
  });
  expect(ctx.authDownload["x-rbox-version"]).toBe(RBOX_VERSION);
  expect(ctx.batchPutAuth["x-rbox-version"]).toBe(RBOX_VERSION);
});
