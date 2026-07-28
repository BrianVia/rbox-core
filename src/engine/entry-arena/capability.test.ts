import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as barrel from "./index.js";
import { EntryArena } from "./arena.js";
import { PublishedGeneration } from "./generation.js";
import { GenerationOwnerScope, publishGeneration, withGenerationOwnerScope } from "./owner.js";
import type { FileEntry } from "../types.js";

const HERE = path.dirname(Bun.fileURLToPath(import.meta.url));

function entry(entryPath: string): FileEntry {
  return { path: entryPath, sha256: `sha-${entryPath}`, size: 3, mode: 0o644, mtimeMs: 1000, type: "file" };
}

test("REGRESSION (r3 finding 1): the barrel exports no capability-minting surface", () => {
  const names = Object.keys(barrel);
  for (const forbidden of [
    "takeOwnerCapability",
    "takePublicationCapability",
    "resolvePublishedGeneration",
    "createRegistration",
    "CandidateGeneration",
    "SCOPE_KEY",
  ]) {
    expect(names).not.toContain(forbidden);
  }
  expect(names).toContain("withGenerationOwnerScope");
});

test("REGRESSION (r3 finding 1): a scope cannot be constructed without withGenerationOwnerScope", async () => {
  const arena = new EntryArena();
  expect(() => new GenerationOwnerScope(arena, Symbol("forged"))).toThrow(/only by withGenerationOwnerScope/);
  await withGenerationOwnerScope(arena, (scope) => {
    expect(scope).toBeInstanceOf(GenerationOwnerScope);
  });
});

test("REGRESSION (r3 finding 1): a hand-constructed PublishedGeneration is inert", async () => {
  const arena = new EntryArena();
  const slot = arena.internExact(entry("a.txt"));
  // The constructor needs no key because it grants nothing: only the publisher
  // registers a token, and only a registered token can seed.
  const forged = new PublishedGeneration(arena, 1, [{ path: "a.txt", state: { slot, pathEpoch: 0 } }]);
  await withGenerationOwnerScope(arena, async (scope) => {
    expect(() => scope.createOwner({ seedFrom: forged.token })).toThrow(/not live/);
    const real = scope.createOwner({ entries: [entry("b.txt")] });
    const published = await publishGeneration(real.owner, real.token);
    scope.createOwner({ seedFrom: published.token });
    published.release();
    expect(() => scope.createOwner({ seedFrom: published.token })).toThrow(/not live/);
  });
  arena.release(slot);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

const PROBE = `
const order = process.argv.slice(2);
const loaded = [];
for (const specifier of order) loaded.push(await import(specifier));
const named = (key) => loaded.find((module) => key in module)?.[key];

const handoffs = [];
for (const module of loaded) {
  for (const key of Object.keys(module)) {
    if (/^take[A-Za-z]*Capability$/.test(key) || /_KEY$/.test(key) || /^create[A-Za-z]*Control$/.test(key)) {
      handoffs.push(key);
    }
  }
}

const EntryArena = named("EntryArena");
const Scope = named("GenerationOwnerScope");
const Published = named("PublishedGeneration");
const withScope = named("withGenerationOwnerScope");

let forgedScope = "unavailable";
if (Scope && EntryArena) {
  try {
    new Scope(new EntryArena(), Symbol("forged"));
    forgedScope = "MINTED";
  } catch {
    forgedScope = "refused";
  }
}

let forgedSeed = "unavailable";
if (Published && EntryArena && withScope) {
  const arena = new EntryArena();
  const slot = arena.internExact({ path: "a.txt", sha256: "s", size: 1, mode: 420, mtimeMs: 1, type: "file" });
  const forged = new Published(arena, 1, [{ path: "a.txt", state: { slot, pathEpoch: 0 } }]);
  await withScope(arena, (scope) => {
    try {
      scope.createOwner({ seedFrom: forged.token });
      forgedSeed = "SEEDED";
    } catch {
      forgedSeed = "refused";
    }
  });
}

console.log(JSON.stringify({ handoffs, forgedScope, forgedSeed }));
`;

interface ProbeResult {
  handoffs: string[];
  forgedScope: string;
  forgedSeed: string;
}

async function probe(script: string, order: string[]): Promise<ProbeResult> {
  const child = Bun.spawn(["bun", "run", script, ...order.map((name) => path.join(HERE, name))], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`probe failed (${code}): ${stderr}`);
  return JSON.parse(stdout) as ProbeResult;
}

test("REGRESSION (r3 finding 1): no import order in a fresh process yields a capability", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u0-probe-"));
  const script = path.join(directory, "probe.mjs");
  await fs.writeFile(script, PROBE);
  try {
    const orders = [
      ["owner.ts", "generation.ts", "arena.ts"],
      ["generation.ts", "owner.ts", "arena.ts"],
      ["arena.ts", "generation.ts", "owner.ts"],
      ["workers.ts", "generation.ts", "owner.ts", "arena.ts"],
      ["queue.ts", "owner.ts", "arena.ts", "generation.ts"],
      ["index.ts", "owner.ts", "generation.ts", "arena.ts"],
    ];
    for (const order of orders) {
      const result = await probe(script, order);
      expect({ order, ...result }).toEqual({ order, handoffs: [], forgedScope: "refused", forgedSeed: "refused" });
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);
