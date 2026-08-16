import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResetFenceObservation } from "./reset-journal-inspection.js";
import { statePath } from "./state-plane/paths.js";

describe("reset fence observation over real-sized state", () => {
  test("a state.json larger than 512 KiB is fingerprinted, not refused as oversized", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fence-cap-"));
    try {
      const file = statePath(root);
      await fs.mkdir(path.dirname(file), { recursive: true });
      // A legitimately large legacy state document: the desktop field workspace
      // that exposed the refusal carried 73 MiB. One MiB is enough to cross the
      // old 512 KiB control-hash cap without slowing the suite.
      const body = JSON.stringify({ stream: "s", pad: "x".repeat(1024 * 1024) });
      await fs.writeFile(file, body);
      const observation = await createResetFenceObservation(root, undefined, { kind: "none" }, [file]);
      expect(observation.root).toBe(path.resolve(root));

      // The same artifact list must also notice a content change: the cap fix
      // must not have degraded the control hash into a stat-only fingerprint.
      const changed = JSON.stringify({ stream: "s", pad: "y".repeat(1024 * 1024) });
      await fs.writeFile(`${file}.next`, changed);
      await fs.rename(`${file}.next`, file);
      const after = await createResetFenceObservation(root, undefined, { kind: "none" }, [file]);
      expect(after.fingerprint).not.toBe(observation.fingerprint);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
