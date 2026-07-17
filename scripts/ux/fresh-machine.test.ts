import { afterEach, describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  assertDevRemote, assertMachineHome, assertNoAncestorWorkspace, childFailure, containerBootstrapLoginCommand,
  createWorkspaceFixture, DEV_API, envPrefix, hostBootstrapLoginArgs, isolatedEnv, listWorkspaceIds,
  desiredRootsHost, isCanonicalChild, machineLabel, normalizedBootstrapEnv, parseFreshArgs, storedWorkspaceCredentials,
  rboxSpawnOptions, readRegularFile, safeId, UX_ROOT, withFailureCleanup,
} from "./fresh-machine.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((p) => fsp.rm(p, { recursive: true, force: true }))); });

describe("fresh-machine argument parsing", () => {
  test("parses create, destroy, and list", () => {
    expect(parseFreshArgs(["create", "--name", "a", "--enrolled", "--run-id", "walk_1"])).toEqual({ command: "create", name: "a", enrolled: true, plan: "solo", runId: "walk_1", host: false });
    expect(parseFreshArgs(["destroy", "--run-id", "walk", "--name", "a"])).toEqual({ command: "destroy", runId: "walk", name: "a", host: false });
    expect(parseFreshArgs(["list"])).toEqual({ command: "list", host: false });
    expect(parseFreshArgs(["create", "--name", "a", "--host"])).toMatchObject({ command: "create", enrolled: false, plan: "none", host: true });
    expect(parseFreshArgs(["list", "--host"])).toEqual({ command: "list", host: true });
    expect(parseFreshArgs(["workspaces", "--run-id", "walk", "--name", "a"])).toEqual({ command: "workspaces", runId: "walk", name: "a", host: false });
    expect(parseFreshArgs(["workspaces-create", "--host", "--run-id", "walk", "--name", "a", "--label", "Never pushed"])).toEqual({ command: "workspaces-create", runId: "walk", name: "a", label: "Never pushed", host: true });
  });

  test.each([
    [[], "missing command"],
    [["create"], "requires --name"],
    [["create", "--name", "a", "--name", "b"], "duplicate option"],
    [["create", "--wat"], "unknown option"],
    [["destroy", "--name", "a"], "requires --run-id"],
    [["list", "--name", "a"], "unknown option"],
    [["create", "--name", "a", "--plan", "solo"], "requires --enrolled"],
    [["create", "--name", "a", "--enrolled", "--plan", "team"], "solo, pro, or none"],
    [["workspaces", "--run-id", "walk"], "requires --name"],
    [["workspaces-create", "--run-id", "walk", "--name", "a"], "requires --label"],
  ] as const)("rejects invalid argv %#", (argv, message) => expect(() => parseFreshArgs([...argv])).toThrow(message));
});

test("enrolled plan matrix is identical on host and container command paths", () => {
  for (const host of [false, true]) {
    const target = host ? ["--host"] : [];
    expect(parseFreshArgs(["create", "--name", "a", "--enrolled", ...target])).toMatchObject({ enrolled: true, plan: "solo", host });
    expect(parseFreshArgs(["create", "--name", "a", "--enrolled", "--plan", "solo", ...target])).toMatchObject({ plan: "solo", host });
    expect(parseFreshArgs(["create", "--name", "a", "--enrolled", "--plan", "pro", ...target])).toMatchObject({ plan: "pro", host });
    expect(parseFreshArgs(["create", "--name", "a", "--enrolled", "--plan", "none", ...target])).toMatchObject({ plan: "none", host });
    expect(() => parseFreshArgs(["create", "--name", "a", "--plan", "none", ...target])).toThrow("requires --enrolled");
  }

  expect(hostBootstrapLoginArgs("secret", "ux-walk-a", "solo")).toEqual([
    "login", "--bootstrap", "secret", "--label", "ux-walk-a", "--remote", DEV_API, "--plan", "solo",
  ]);
  expect(hostBootstrapLoginArgs("secret", "ux-walk-a", "none")).not.toContain("--plan");
  expect(containerBootstrapLoginCommand("ux-walk-a", "pro")).toEqual([
    "sh", "-c", 'exec rbox login --bootstrap "$RBOX_UX_BOOTSTRAP" "$@"', "ux-login",
    "--label", "ux-walk-a", "--remote", DEV_API, "--plan", "pro",
  ]);
  expect(containerBootstrapLoginCommand("ux-walk-a", "none")).not.toContain("--plan");
});

test("safe ids produce attributed labels and reject path syntax", () => {
  expect(machineLabel("run-7", "mac_a")).toBe("ux-run-7-mac_a");
  for (const value of ["../x", "a/b", ".", "", "a b"]) expect(() => safeId("id", value)).toThrow();
});

test("only the exact DEV API is accepted", () => {
  expect(() => assertDevRemote(DEV_API)).not.toThrow();
  for (const remote of ["https://api.rbox.to", "https://rbox-prod-api.brian-via.workers.dev", `${DEV_API}/`, "http://localhost:8787"]) {
    expect(() => assertDevRemote(remote)).toThrow("refusing non-DEV");
  }
});

test("workspace helpers authenticate, paginate, and use stable result contracts", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const pages = [
    { workspaces: [{ workspaceId: "ws_one" }], nextCursor: "next/page" },
    { workspaces: [{ workspaceId: "ws_two" }], nextCursor: null },
  ];
  const ids = await listWorkspaceIds(DEV_API, "device-token", async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json(pages.shift());
  });
  expect(ids).toEqual(["ws_one", "ws_two"]);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.init?.headers).toEqual({ authorization: "Bearer device-token" });
  expect(new URL(requests[0]!.url).searchParams.get("limit")).toBe("100");
  expect(new URL(requests[1]!.url).searchParams.get("cursor")).toBe("next/page");

  let createdRequest: { url: string; init?: RequestInit } | undefined;
  const workspaceId = await createWorkspaceFixture(DEV_API, "device-token", "Never pushed / ☃", async (input, init) => {
    createdRequest = { url: String(input), init };
    return Response.json({ workspaceId: "ws_fresh" });
  });
  expect(workspaceId).toBe("ws_fresh");
  expect(createdRequest!.init).toMatchObject({ method: "POST", headers: { authorization: "Bearer device-token" } });
  expect(new URL(createdRequest!.url).searchParams.get("project")).toBe("root");
  expect(new URL(createdRequest!.url).searchParams.get("name")).toBe("Never pushed / ☃");
});

test("workspace helpers derive authority from stored DEV credentials and guard before fetch", async () => {
  expect(storedWorkspaceCredentials(JSON.stringify({ remoteUrl: DEV_API, token: "device-token" }))).toEqual({ remote: DEV_API, token: "device-token" });
  expect(() => storedWorkspaceCredentials(JSON.stringify({ remoteUrl: "https://api.rbox.to", token: "device-token" }))).toThrow("refusing non-DEV");

  let fetched = false;
  const shouldNotFetch = async (): Promise<Response> => { fetched = true; return Response.json({}); };
  await expect(listWorkspaceIds("https://api.rbox.to", "device-token", shouldNotFetch)).rejects.toThrow("refusing non-DEV");
  await expect(createWorkspaceFixture("https://api.rbox.to", "device-token", "label", shouldNotFetch)).rejects.toThrow("refusing non-DEV");
  expect(fetched).toBeFalse();
});

test("isolated environment forces machine state and removes ambient authority", () => {
  const env = isolatedEnv("/tmp/rbox-ux/r/a", {
    HOME: "/real", RBOX_HOME: "/real/.rbox", RBOX_API: "https://api.rbox.to",
    RBOX_TOKEN: "token", RBOX_PAIR_TOKEN: "pair", RBOX_CONFIG_DIR: "/real/config",
    RBOX_DEV_BOOTSTRAP: "bootstrap", RBOX_KEY: "root-bundle", RBOX_APP: "https://app.rbox.to", KEEP: "yes",
  });
  expect(env).toMatchObject({ HOME: "/tmp/rbox-ux/r/a", RBOX_HOME: "/tmp/rbox-ux/r/a", RBOX_API: DEV_API, RBOX_API_QUIET: "1", KEEP: "yes" });
  for (const key of ["RBOX_TOKEN", "RBOX_PAIR_TOKEN", "RBOX_CONFIG_DIR", "RBOX_DEV_BOOTSTRAP", "RBOX_KEY"]) expect(env[key]).toBeUndefined();
  expect(env.RBOX_APP).toBe("");
});

test("printed prefix pins cwd, is reusable and quoted, and scrubs authority", () => {
  const prefix = envPrefix("/tmp/rbox-ux/run/a'b");
  expect(prefix).toStartWith(`cd '/tmp/rbox-ux/run/a'\"'\"'b' && env -u RBOX_TOKEN`);
  expect(prefix).toContain("-u RBOX_KEY");
  expect(prefix).toContain("RBOX_API='https://rbox-dev-api.brian-via.workers.dev'");
  expect(prefix).toContain("a'\"'\"'b");
  expect(prefix).not.toContain("\n");
  expect(prefix.endsWith(" rbox")).toBeTrue();
});

test("every fresh-machine rbox spawn pins cwd to the machine HOME", () => {
  const home = "/tmp/rbox-ux/run/a";
  expect(rboxSpawnOptions(home)).toMatchObject({ cwd: home, env: { HOME: home, RBOX_HOME: home, RBOX_API: DEV_API }, stdout: "pipe", stderr: "pipe" });
});

test("ancestor workspace guard names the offending directory", async () => {
  const root = path.join("/tmp", `rbox-ux-guard-${Math.random().toString(16).slice(2)}`); cleanup.push(root);
  const workspace = path.join(root, "operator");
  const home = path.join(workspace, "nested", "machine");
  await fsp.mkdir(path.join(workspace, ".rbox"), { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(workspace, ".rbox", "workspace.json"), "{}");
  await expect(assertNoAncestorWorkspace(home)).rejects.toThrow(`inside workspace at ${workspace}`);
  await fsp.rm(path.join(workspace, ".rbox"), { recursive: true });
  await fsp.mkdir(path.join(home, ".rbox"), { recursive: true });
  await fsp.symlink(path.join(root, "missing-target"), path.join(home, ".rbox", "workspace.json"));
  await expect(assertNoAncestorWorkspace(home)).rejects.toThrow(`inside workspace at ${home}`);
  await fsp.rm(path.join(home, ".rbox"), { recursive: true });
  await expect(assertNoAncestorWorkspace(home)).resolves.toBeUndefined();
});

test("canonical containment allows macOS /tmp aliases without allowing escape", () => {
  expect(isCanonicalChild("/private/tmp/rbox-ux", "/private/tmp/rbox-ux/run/a")).toBeTrue();
  expect(isCanonicalChild("/private/tmp/rbox-ux", "/private/tmp/operator-home")).toBeFalse();
});

test("bootstrap env aliases preserve primary precedence", () => {
  expect(normalizedBootstrapEnv({ RBOX_DEV_BOOTSTRAP: "first", RBOX_DEV_BOOTSTRAP_SECRET: "second" }).RBOX_DEV_BOOTSTRAP).toBe("first");
  expect(normalizedBootstrapEnv({ RBOX_DEV_BOOTSTRAP_SECRET: "second" }).RBOX_DEV_BOOTSTRAP).toBe("second");
});

test("child failures never replay captured secrets", () => {
  const error = childFailure("bootstrap", 1, "recovery phrase bootstrap-secret");
  expect(error.message).toContain("output suppressed");
  expect(error.message).not.toContain("recovery phrase");
  expect(error.message).not.toContain("bootstrap-secret");
});

test("machine HOME validation accepts real shape and rejects a symlink machine", async () => {
  const run = `test-${Math.random().toString(16).slice(2)}`;
  const runDir = path.join(UX_ROOT, run); cleanup.push(runDir);
  const home = path.join(runDir, "a");
  await fsp.mkdir(home, { recursive: true });
  expect(await assertMachineHome(home)).toBe(home);
  const link = path.join(runDir, "linked");
  await fsp.symlink("/tmp", link);
  await expect(assertMachineHome(link)).rejects.toThrow("real directory");
  await expect(assertMachineHome("/tmp/not-rbox-ux/a")).rejects.toThrow("machine HOME must be");
});

test("teardown inputs must be regular files, never symlinks", async () => {
  const dir = path.join(UX_ROOT, `files-${Math.random().toString(16).slice(2)}`); cleanup.push(dir);
  await fsp.mkdir(dir, { recursive: true });
  const real = path.join(dir, "real.json"); const link = path.join(dir, "credentials.json");
  await fsp.writeFile(real, "{}"); await fsp.symlink(real, link);
  expect(await readRegularFile(real)).toBe("{}");
  await expect(readRegularFile(link)).rejects.toThrow("symlink");
});

test("host teardown rejects symlinked state-directory ancestors", async () => {
  const root = path.join("/tmp", `rbox-ux-state-${Math.random().toString(16).slice(2)}`); cleanup.push(root);
  const home = path.join(root, "home"); const outside = path.join(root, "outside");
  await fsp.mkdir(path.join(outside, "daemons"), { recursive: true }); await fsp.mkdir(home, { recursive: true });
  await fsp.symlink(outside, path.join(home, ".rbox"));
  await expect(desiredRootsHost(home)).rejects.toThrow("symlinked state directory");
  await fsp.rm(path.join(home, ".rbox")); await fsp.mkdir(path.join(home, ".rbox"));
  await fsp.symlink(path.join(outside, "daemons"), path.join(home, ".rbox", "daemons"));
  await expect(desiredRootsHost(home)).rejects.toThrow("symlinked state directory");
});

test("failed enrollment awaits cleanup and preserves the original error", async () => {
  const order: string[] = [];
  await expect(withFailureCleanup(async () => { order.push("work"); throw new Error("login failed"); }, async () => { order.push("cleanup"); })).rejects.toThrow("login failed");
  expect(order).toEqual(["work", "cleanup"]);
});
