import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { migrateStateInUpgradeWindow } from "./upgrade-state-window.js";

test("retired upgrade state window remains present but performs no state-plane work", async () => {
  const outcome = await migrateStateInUpgradeWindow("/never-read", "workspace-key");
  expect(outcome).toEqual({ ok: true, lines: [] });

  const upgrade = fs.readFileSync(path.join(import.meta.dir, "upgrade-cmd.ts"), "utf8");
  expect(upgrade).not.toContain("upgrade-state-window");
  expect(upgrade).not.toContain("migrateStateInUpgradeWindow");

  const retired = fs.readFileSync(path.join(import.meta.dir, "upgrade-state-window.ts"), "utf8");
  expect(retired).toContain("Retired SP-3");
  expect(retired).not.toContain("runMigration");
  expect(retired).not.toContain("state-plane/authority-bootstrap");
});
