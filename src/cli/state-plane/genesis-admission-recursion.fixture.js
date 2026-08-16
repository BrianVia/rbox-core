import { mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const format = process.argv[2];
if (format !== "absent" && format !== "q-intent") throw new Error("expected absent or q-intent");

const inventorySentinel = () => {
  throw new Error("whole-state inventory recursion sentinel was reached");
};
mock.module("./adapters/whole-state-compat.js", () => ({
  loadRawState: inventorySentinel,
  loadState: inventorySentinel,
}));

const [{ admitGenesisAuthority }, mutexes, configModule, paths, storeModule, intentModule] = await Promise.all([
  import("./authority-bootstrap.js"),
  import("../sync-mutex.js"),
  import("../workspace-config.js"),
  import("./paths.js"),
  import("./store/open.js"),
  import("./genesis-intent.js"),
]);

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `rbox-admission-recursion-${format}-`)));
const config = {
  schema: "e2ee/v1",
  remoteWorkspaceId: "ws-recursion",
  projectId: "root",
  deviceId: "dev-recursion",
  rootPath: root,
  remoteUrl: "https://example.invalid",
  token: "",
};
await configModule.saveConfig(root, config);
await fs.mkdir(paths.sqliteResetPaths.stateRoot(root), { recursive: true });

const mutex = await mutexes.acquireWorkspaceSyncMutex(root, "cli");
try {
  let admitted = await admitGenesisAuthority(root, mutex);
  if (admitted.kind !== "selected") throw new Error("fixture admission refused");
  let selection = admitted.authority;
  if (format === "q-intent") {
    if (selection.kind !== "sqlite-store") throw new Error("fixture did not establish Q");
    const active = paths.sqliteResetPaths.active(root);
    const stat = await fs.stat(active);
    const store = storeModule.openStateStore(active, { readonly: true });
    const lineageId = store.header.active_lineage_id;
    store.close();
    await fs.writeFile(paths.genesisPaths.intent(root), JSON.stringify({
      version: 1,
      authorityId: selection.authorityId,
      lineageId,
      evidence: {
        root,
        stream: configModule.syncStreamId(config),
        incarnation: "absent",
      },
      staging: { dev: stat.dev, ino: stat.ino },
    }));
    admitted = await admitGenesisAuthority(root, mutex);
    if (admitted.kind !== "selected") throw new Error("fixture recovery refused");
    selection = admitted.authority;
  }
  process.stdout.write(JSON.stringify({
    format,
    kind: selection.kind,
    intent: intentModule.readGenesisIntent(root) !== undefined,
  }));
} finally {
  await mutexes.releaseWorkspaceSyncMutex(mutex);
  await fs.rm(root, { recursive: true, force: true });
}
