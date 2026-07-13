#!/usr/bin/env bun
import { basename } from "node:path";

type Shard = {
  units: TestUnit[];
  weight: number;
};

type Command = "list" | "command" | "run" | "guard" | "plan";
type TestUnit = {
  label: string;
  files: string[];
  names?: string[];
  pattern?: string;
  weight: number;
};

const HEAVY_WEIGHTS: Record<string, number> = {
  // These hints keep the runtime partition balanced without hardcoding complete
  // shard file lists. Every test is still discovered from src/**/*.test.ts.
  "src/cli/daemon-activity.test.ts": 24,
  "src/cli/sync.test.ts": 13,
  "src/cli/e2ee-sync.test.ts": 3,
  "src/cli/shell-init.test.ts": 3,
  "src/cli/daemon-binding.test.ts": 7,
  "src/cli/daemon-spawn.test.ts": 7,
  "src/cli/daemon-safety.test.ts": 5,
  "src/cli/daemon-logs.test.ts": 5,
  "src/cli/daemon-watch-degrade.test.ts": 5,
  "src/engine/e2ee/e2ee-e2e.test.ts": 4,
};

const SPLIT_FILES: Record<string, { parts: number; weight: number; partWeights?: number[] }> = {
  // Measured locally: git-sync is ~84s and git-nested is ~20s as single files,
  // so a file-only partition cannot hit the <=30s target. Split by test names
  // discovered from the source at runtime; the guard verifies every discovered
  // test name in these files is covered exactly once.
  "src/cli/git-sync.test.ts": { parts: 12, weight: 73, partWeights: [8.8, 8.8, 6, 5.3, 5.4, 4.5, 4.7, 3.9, 8, 3.9, 4.3, 3.3] },
  "src/engine/git-nested.test.ts": { parts: 4, weight: 19, partWeights: [6, 3.7, 4, 5.2] },
};
const DEFAULT_WEIGHT = 0.5;

function usage(): never {
  console.error(`usage: bun scripts/${basename(import.meta.path)} <list|command|run|guard|plan> --shard-count N [--shard-index I]`);
  process.exit(2);
}

function argValue(name: string): string | undefined {
  const prefixed = `${name}=`;
  for (let i = 3; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg?.startsWith(prefixed)) return arg.slice(prefixed.length);
  }
  return undefined;
}

function intArg(name: string, fallback?: number): number {
  const raw = argValue(name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    usage();
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) usage();
  return n;
}

async function discoverTests(): Promise<string[]> {
  const glob = new Bun.Glob("src/**/*.test.ts");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
    files.push(file.replaceAll("\\", "/"));
  }
  return files.sort();
}

function stableHash(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function weightOf(file: string): number {
  return HEAVY_WEIGHTS[file] ?? DEFAULT_WEIGHT;
}

function regexEscape(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function patternFor(names: string[]): string {
  return `^(?:${names.map(regexEscape).join("|")})$`;
}

async function testNames(file: string): Promise<string[]> {
  const source = await Bun.file(file).text();
  const names: string[] = [];
  const re = /^test\("((?:[^"\\]|\\.)*)"/gm;
  for (const match of source.matchAll(re)) {
    names.push(JSON.parse(`"${match[1]}"`) as string);
  }
  if (names.length === 0) {
    console.error(`no test(...) names discovered in split file: ${file}`);
    process.exit(1);
  }
  return names;
}

async function buildUnits(files: string[]): Promise<TestUnit[]> {
  const units: TestUnit[] = [];
  for (const file of files) {
    const split = SPLIT_FILES[file];
    if (!split) {
      units.push({ label: file, files: [file], weight: weightOf(file) });
      continue;
    }

    const names = await testNames(file);
    const buckets = Array.from({ length: split.parts }, () => [] as string[]);
    for (let i = 0; i < names.length; i++) buckets[i % split.parts]!.push(names[i]!);
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i]!;
      units.push({
        label: `${file}#${i + 1}/${split.parts}`,
        files: [file],
        names: bucket,
        pattern: patternFor(bucket),
        weight: split.partWeights?.[i] ?? split.weight / split.parts,
      });
    }
  }
  return units;
}

function partition(units: TestUnit[], shardCount: number): Shard[] {
  if (shardCount < 1) usage();
  const shards = Array.from({ length: shardCount }, () => ({ units: [], weight: 0 }));
  const ordered = units
    .map((unit) => ({ unit, hash: stableHash(unit.label) }))
    .sort((a, b) => b.unit.weight - a.unit.weight || a.hash - b.hash || a.unit.label.localeCompare(b.unit.label));

  for (const entry of ordered) {
    let target = 0;
    for (let i = 1; i < shards.length; i++) {
      const shard = shards[i]!;
      const best = shards[target]!;
      if (shard.weight < best.weight || (shard.weight === best.weight && i < target)) {
        target = i;
      }
    }
    shards[target]!.units.push(entry.unit);
    shards[target]!.weight += entry.unit.weight;
  }

  for (const shard of shards) shard.units.sort((a, b) => a.label.localeCompare(b.label));
  return shards;
}

async function verify(files: string[], shards: Shard[]): Promise<void> {
  const expected = new Set(files);
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  const splitCoverage = new Map<string, string[]>();

  for (const shard of shards) {
    for (const unit of shard.units) {
      for (const file of unit.files) {
        const count = seen.get(file) ?? 0;
        if (count > 0 && !SPLIT_FILES[file]) duplicates.push(file);
        seen.set(file, count + 1);
      }
      if (unit.pattern && unit.files.length === 1) {
        const file = unit.files[0]!;
        const names = splitCoverage.get(file) ?? [];
        names.push(...(unit.names ?? []));
        splitCoverage.set(file, names);
      }
    }
  }

  const missing = files.filter((file) => !seen.has(file));
  const extra = [...seen.keys()].filter((file) => !expected.has(file));
  const empty = shards.flatMap((shard, index) => (shard.units.length === 0 ? [index] : []));
  const splitErrors: string[] = [];
  for (const file of Object.keys(SPLIT_FILES)) {
    const expectedNames = await testNames(file);
    const covered = splitCoverage.get(file) ?? [];
    const counts = new Map<string, number>();
    for (const name of covered) counts.set(name, (counts.get(name) ?? 0) + 1);
    const missingNames = expectedNames.filter((name) => !counts.has(name));
    const duplicateNames = [...counts.entries()].filter(([, count]) => count !== 1).map(([name]) => name);
    if (missingNames.length || duplicateNames.length) {
      splitErrors.push(`${file}: missing ${missingNames.length}, duplicate ${duplicateNames.length}`);
    }
  }

  if (missing.length || duplicates.length || extra.length || empty.length || splitErrors.length) {
    if (missing.length) console.error(`missing files:\n${missing.join("\n")}`);
    if (duplicates.length) console.error(`duplicate files:\n${duplicates.join("\n")}`);
    if (extra.length) console.error(`extra files:\n${extra.join("\n")}`);
    if (empty.length) console.error(`empty shards: ${empty.join(", ")}`);
    if (splitErrors.length) console.error(`split coverage errors:\n${splitErrors.join("\n")}`);
    process.exit(1);
  }
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

const command = process.argv[2] as Command | undefined;
if (!command || !["list", "command", "run", "guard", "plan"].includes(command)) usage();

const shardCount = intArg("--shard-count");
const files = await discoverTests();
const units = await buildUnits(files);
const shards = partition(units, shardCount);
await verify(files, shards);

if (command === "guard") {
  console.log(`ci-shard-tests: ${files.length} files and ${units.length} runtime units covered across ${shardCount} shards`);
  process.exit(0);
}

if (command === "plan") {
  for (let i = 0; i < shards.length; i++) {
    const shard = shards[i]!;
    console.log(`shard ${i}/${shardCount}: ${shard.units.length} units, weight ${shard.weight}`);
    for (const unit of shard.units) {
      const split = unit.pattern ? ` (${unit.files[0]}, split, w=${unit.weight})` : HEAVY_WEIGHTS[unit.label] ? ` (w=${HEAVY_WEIGHTS[unit.label]})` : "";
      console.log(`  ${unit.label}${split}`);
    }
  }
  process.exit(0);
}

const shardIndex = intArg("--shard-index");
if (shardIndex >= shardCount) usage();

const shard = shards[shardIndex]!;
if (command === "list") {
  for (const unit of shard.units) {
    console.log(unit.pattern ? `${unit.files.join(" ")} --test-name-pattern ${shellQuote(unit.pattern)}` : unit.files.join(" "));
  }
  process.exit(0);
}

const splitUnits = shard.units.filter((unit) => unit.pattern);
const fileUnits = shard.units.filter((unit) => !unit.pattern);
const splitGroups = new Map<string, string[]>();
for (const unit of splitUnits) {
  const file = unit.files[0]!;
  splitGroups.set(file, [...(splitGroups.get(file) ?? []), ...(unit.names ?? [])]);
}
// Shared self-hosted runners contend (8 runners/box + local dev load); bun's 5s
// default per-test timeout flakes under that load. 15s still catches real hangs.
const TEST_TIMEOUT = ["--timeout", "15000"];
const commands = [
  ...(fileUnits.length > 0 ? [["bun", "test", ...TEST_TIMEOUT, ...fileUnits.flatMap((unit) => unit.files)]] : []),
  ...[...splitGroups.entries()].map(([file, names]) => ["bun", "test", ...TEST_TIMEOUT, "--test-name-pattern", patternFor(names), file]),
];
const rendered = commands.map((argv) => argv.map(shellQuote).join(" ")).join("\n");

if (command === "command") {
  console.log(rendered);
  process.exit(0);
}

for (const argv of commands) {
  console.error(`$ ${argv.map(shellQuote).join(" ")}`);
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}
