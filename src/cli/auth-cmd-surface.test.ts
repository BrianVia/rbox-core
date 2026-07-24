import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import * as authCommand from "./auth-cmd.js";

const expectedRuntimeExports = [
  "EXISTING_ACCOUNT_ENROLLMENT_MESSAGE",
  "WORKSPACE_SYNC_NEXT_STEP",
  "approveDevice",
  "completeStagedGenesisRecoveryKit",
  "defaultGenesisRecoveryKitCompletion",
  "deviceApprovalUrl",
  "deviceCodeEnrollmentNote",
  "deviceCodeLoginShouldPrintWorkspaceStep",
  "handleDeviceCodePostApprovalEncryption",
  "keyBackup",
  "keyGenesis",
  "keySave",
  "keyStatus",
  "listDevices",
  "login",
  "logout",
  "offerRecoveryKitAfterRecover",
  "pairCreate",
  "pairingConnectCommand",
  "pairingRedemptionSuccessMessages",
  "presentPairingConnectCommand",
  "readPairingTokenInteractive",
  "recoverCmd",
  "recoveryPhraseFromKeychain",
  "redeemPair",
  "revokeDevice",
  "runDeviceCodeLogin",
  "runGenesisEnrollment",
  "transitionDeviceLogin",
];

test("auth-cmd preserves its exact runtime compatibility surface", () => {
  expect(Object.keys(authCommand).sort()).toEqual(expectedRuntimeExports);
});

test("auth-cmd remains an explicit logic-free barrel", async () => {
  const source = await fs.readFile(new URL("./auth-cmd.ts", import.meta.url), "utf8");
  expect(source).not.toContain("export *");
  expect(source).not.toMatch(/\b(?:async\s+)?function\b|\bclass\b|=>/);
  expect(source.split("\n").filter((line) => line.trim() !== "").every(
    (line) => line.startsWith("export ") || line.startsWith("  ") || line.startsWith("} from "),
  )).toBe(true);
});

test("auth owner modules are acyclic and never import the compatibility barrel", async () => {
  const authDirectory = path.dirname(new URL("./auth/device-login.ts", import.meta.url).pathname);
  const files = (await fs.readdir(authDirectory))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(authDirectory, file));
  const wire = path.join(path.dirname(authDirectory), "remote", "auth-command-wire.ts");
  files.push(wire);

  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*auth-cmd\.js["']/);
    const dependencies = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)]
      .map((match) => path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, ".ts")))
      .filter((dependency) => files.includes(dependency));
    graph.set(file, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visiting.has(file)) throw new Error(`auth import cycle at ${path.basename(file)}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of files) visit(file);
});
