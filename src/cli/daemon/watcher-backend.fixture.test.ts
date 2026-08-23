import { expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

if (process.env.RBOX_WATCHER_BACKEND_FIXTURE !== "1") {
} else {
  interface NativeOptions {
    backend?: "fs-events" | "inotify";
    ignoreGlobs?: string[];
    ignorePaths?: string[];
  }
  type NativeCallback = (error: Error | null, events?: Array<{ path: string; type: string }>) => void;
  interface NativeBinding {
    subscribe(dir: string, callback: NativeCallback, options: NativeOptions): Promise<void>;
    unsubscribe(dir: string, callback: NativeCallback, options: NativeOptions): Promise<void>;
  }
  interface NativeWrapper {
    subscribe(dir: string, callback: NativeCallback, options: NativeOptions): Promise<{ unsubscribe(): Promise<void> }>;
  }
  const expectedBackend = process.platform === "darwin" ? "fs-events" : "inotify";
  let subscribeOptions: NativeOptions | undefined;
  let unsubscribeOptions: NativeOptions | undefined;

  const binding: NativeBinding = {
    async subscribe(_dir: string, _callback: NativeCallback, options: NativeOptions) {
      subscribeOptions = options;
    },
    async unsubscribe(_dir: string, _callback: NativeCallback, options: NativeOptions) {
      unsubscribeOptions = options;
    },
  };
  const require = createRequire(import.meta.url);
  const actualWrapper = require("@parcel/watcher/wrapper") as { createWrapper(binding: NativeBinding): NativeWrapper };
  mock.module("@parcel/watcher/wrapper", () => ({
    createWrapper: () => actualWrapper.createWrapper(binding),
  }));

  const { startWatcher } = await import("./watcher.js");
  test("native binding receives the platform backend on subscribe and unsubscribe", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-watcher-backend-"));
    try {
      const watcher = await startWatcher(root, { ignores: () => false, prunes: () => false }, () => {}, { backend: "parcel" });
      expect(subscribeOptions?.backend).toBe(expectedBackend);
      await watcher.close();
      expect(unsubscribeOptions).toBe(subscribeOptions);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
