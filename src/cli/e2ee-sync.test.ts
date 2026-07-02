import { afterAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildPairing, redeemPairing, type DeviceSecrets, type SignedRoster } from "../engine/e2ee/index.js";
import type { GitSection } from "../engine/index.js";
import type { E2eeRemote } from "./e2ee-remote.js";
import { bootstrapOnto, cfgFor as harnessCfg, FakeServer, remoteFor as harnessRemote } from "./e2ee-fake-server.js";
import { pull, push } from "./sync.js";
import { loadState, type WorkspaceConfig } from "./config.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then((r) => r.stdout.toString().trim());

const NOW = 1_900_000_000_000;
const ACCT = "acct_sync";
const WS = "ws_sync";

const remoteFor = (server: FakeServer, secrets: DeviceSecrets): E2eeRemote => harnessRemote(server, secrets, ACCT, WS, NOW + 5000);
const cfgFor = (root: string, secrets: DeviceSecrets, remote: E2eeRemote): Promise<WorkspaceConfig> => harnessCfg(root, secrets, remote, WS);

let dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-e2ee-sync-"));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

describe("E2EE sync transport — two machines through real sync.ts", () => {
  test("A pushes an encrypted tree; B pairs in and pulls it byte-identically; server sees no plaintext", async () => {
    const server = new FakeServer();

    // --- Machine A: bootstrap account + workspace keys ---
    const secretsA = await bootstrapOnto(server, ACCT, "devA", NOW);

    const rootA = await tmp();
    await fs.mkdir(path.join(rootA, "src"), { recursive: true });
    await fs.writeFile(path.join(rootA, "src", "secret-name.ts"), "export const TOKEN = 'super-secret-do-not-leak';\n");
    await fs.writeFile(path.join(rootA, "README.md"), "# my private project\n");

    const remoteA = await remoteFor(server, secretsA);
    const cfgA = await cfgFor(rootA, secretsA, remoteA);
    const { sequence: seq } = await push(rootA, cfgA, { remote: remoteA });
    expect(seq).toBe(1);

    // GC-root invariant (design 13 G3): the commit's blobRefs must cover every
    // current file blob (so GC reachability never drops a current blob), the
    // encManifest is referenced separately (not in blobRefs), and every referenced
    // blob is actually stored.
    const body = JSON.parse(server.commits[0]!.body) as { blobRefs: { encSha: string }[]; encManifestSha: string };
    const refs = new Set(body.blobRefs.map((r) => r.encSha));
    expect(refs.size).toBe(2); // exactly the two files (secret-name.ts, README.md)
    expect(refs.has(body.encManifestSha)).toBe(false);
    for (const s of refs) expect(server.store.blobs.has(s)).toBe(true);

    // --- Machine B: pair in (token-derived MK wrap + self-admission) ---
    const genesisRoster = JSON.parse(server.account.rosters[0]!) as SignedRoster;
    const tokenSecret = secretsA.mk.slice(0, 32).map((b, i) => b ^ (i + 1)); // any 32 bytes; A would gen random
    const material = await buildPairing(secretsA, { accountEpoch: 0, tokenId: "tok1", tokenSecret, notAfter: NOW + 600_000 });
    const redeem = await redeemPairing({ accountId: ACCT, deviceId: "devB", tokenSecret, accountEpoch: 0, material, prevRoster: genesisRoster, now: NOW + 1000 });
    server.account.rosters.push(JSON.stringify(redeem.admissionRoster));
    server.account.devices.push({ deviceId: "devB", sigPubkey: redeem.device.sigPubKey, encPubkey: redeem.device.encPubKey, mkWrap: JSON.stringify(redeem.device.mkWrap) });

    const rootB = await tmp();
    const remoteB = await remoteFor(server, redeem.secrets);
    const cfgB = await cfgFor(rootB, redeem.secrets, remoteB);
    await pull(rootB, cfgB, { remote: remoteB });

    expect(await fs.readFile(path.join(rootB, "src", "secret-name.ts"), "utf8")).toBe("export const TOKEN = 'super-secret-do-not-leak';\n");
    expect(await fs.readFile(path.join(rootB, "README.md"), "utf8")).toBe("# my private project\n");

    // --- ZERO-KNOWLEDGE: no plaintext name/content anywhere the server holds ---
    for (const needle of ["secret-name.ts", "super-secret-do-not-leak", "my private project", "README.md", "TOKEN"]) {
      for (const bytes of server.allBytes()) {
        expect(Buffer.from(bytes).includes(Buffer.from(needle))).toBe(false);
      }
    }
  });

  test("round-trips edits both directions and converges", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA", NOW);

    const root = await tmp();
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    const remote = await remoteFor(server, secrets);
    const cfg = await cfgFor(root, secrets, remote);
    await push(root, cfg, { remote });

    // second commit (edit) advances the chain; pull on a fresh clone replays both
    await fs.writeFile(path.join(root, "a.txt"), "two\n");
    await fs.writeFile(path.join(root, "b.txt"), "new\n");
    const { sequence: s2 } = await push(root, cfg, { remote });
    expect(s2).toBe(2);

    const root2 = await tmp();
    const remote2 = await remoteFor(server, secrets);
    const cfg2 = await cfgFor(root2, secrets, remote2);
    await pull(root2, cfg2, { remote: remote2 });
    expect(await fs.readFile(path.join(root2, "a.txt"), "utf8")).toBe("two\n");
    expect(await fs.readFile(path.join(root2, "b.txt"), "utf8")).toBe("new\n");
  });

  test("design 43: gitRepos artifact blobs join the commit blobRefs (union, deduped across repos); server sees zero git plaintext", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA", NOW);
    const rootA = await tmp();

    // Two nested repos with IDENTICAL content + pinned dates → identical bundle bytes →
    // ONE convergent encSha referenced by BOTH sections (the §6.5 union-dedup case).
    const DATE = "2026-01-01T00:00:00 +0000";
    for (const r of ["repo1", "repo2"]) {
      const d = path.join(rootA, r);
      await fs.mkdir(d, { recursive: true });
      await git(d, "init", "-qb", "main");
      await fs.writeFile(path.join(d, "f.txt"), "git-secret-content\n");
      await git(d, "add", "f.txt");
      await exec("git", ["-C", d, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "c1"], {
        env: { ...process.env, GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE },
      });
      await git(d, "branch", "secret-branch");
    }

    const remoteA = await remoteFor(server, secrets);
    const cfgA: WorkspaceConfig = { ...(await cfgFor(rootA, secrets, remoteA)), syncGit: true };
    await push(rootA, cfgA, { remote: remoteA });

    const sections = (await loadState(rootA, "ws_sync")).lastSyncedManifest.gitRepos!;
    expect(Object.keys(sections).sort()).toEqual(["repo1", "repo2"]);
    expect(sections["repo1"]!.bundleEncSha).toBe(sections["repo2"]!.bundleEncSha); // convergent bundles

    // G3 invariant, extended by §28/§43: every git artifact encSha is a GC root via
    // blobRefs — union across repos, the shared convergent encSha counted ONCE.
    const body = JSON.parse(server.commits.at(-1)!.body) as { blobRefs: { encSha: string }[] };
    const refShas = body.blobRefs.map((r) => r.encSha);
    expect(new Set(refShas).size).toBe(refShas.length); // no duplicate refs
    const gitShas = (s: GitSection) => [s.bundleEncSha, ...(s.indexEncSha ? [s.indexEncSha] : []), ...Object.values(s.opState ?? {}).map((r) => r.encSha)];
    for (const s of Object.values(sections)) {
      for (const e of gitShas(s)) {
        expect(refShas).toContain(e);
        expect(server.store.blobs.has(e)).toBe(true);
      }
    }

    // ZERO-KNOWLEDGE: no repo path, branch name, or content anywhere the server holds.
    for (const needle of ["repo1", "repo2", "secret-branch", "git-secret-content"]) {
      for (const bytes of server.allBytes()) {
        expect(Buffer.from(bytes).includes(Buffer.from(needle))).toBe(false);
      }
    }

    // A fresh machine pulls: both repos materialize fsck-clean with matching history.
    const rootB = await tmp();
    const remoteB = await remoteFor(server, secrets);
    const cfgB: WorkspaceConfig = { ...(await cfgFor(rootB, secrets, remoteB)), syncGit: true };
    await pull(rootB, cfgB, { remote: remoteB });
    for (const r of ["repo1", "repo2"]) {
      expect(await git(path.join(rootB, r), "rev-parse", "main")).toBe(await git(path.join(rootA, r), "rev-parse", "main"));
      await expect(git(path.join(rootB, r), "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
    }
  }, 20_000);
});
