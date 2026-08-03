import fs from "node:fs";
import path from "node:path";
import { stateStoreDatabase, type StateStoreHandle } from "../store/open.js";
import { runStatement } from "../store/statements.js";

export function vacuumInto(store: StateStoreHandle, output: string): void {
  if (fs.existsSync(output)) throw new Error(`backup staging output already exists: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  runStatement(stateStoreDatabase(store), "VACUUM INTO ?", output);
}
