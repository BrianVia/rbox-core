#!/usr/bin/env bun
import { basename } from "node:path";
import {
  DEDICATED_TESTS,
  DEFAULT_WEIGHT,
  FILE_WEIGHTS,
  SPLIT_FILES,
  WHOLE_FILE_ANTI_AFFINITY,
} from "./ci-shard-weights.js";

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
  antiAffinityGroup?: string;
};


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
  return FILE_WEIGHTS.get(file) ?? DEFAULT_WEIGHT;
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
    const split = SPLIT_FILES.get(file);
    if (!split) {
      units.push({
        label: file,
        files: [file],
        weight: weightOf(file),
        antiAffinityGroup: WHOLE_FILE_ANTI_AFFINITY.get(file),
      });
      continue;
    }

    const names = await testNames(file);
    const dedicated = DEDICATED_TESTS.get(file) ?? [];
    const dedicatedByName = new Map(dedicated.map((entry) => [entry.name, entry]));
    for (const entry of dedicated) {
      const count = names.filter((name) => name === entry.name).length;
      if (count !== 1) {
        console.error(`dedicated test must be discovered exactly once: ${file}: ${entry.name} (found ${count})`);
        process.exit(1);
      }
    }
    const buckets = Array.from({ length: split.parts }, () => [] as string[]);
    // Preserve each residual test's original source-ordinal bucket. Filtering
    // before assigning would reshuffle every name after a dedicated test.
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (!dedicatedByName.has(name)) buckets[i % split.parts]!.push(name);
    }
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
    for (const entry of dedicated) {
      units.push({
        label: `${file}#dedicated:${entry.name}`,
        files: [file],
        names: [entry.name],
        pattern: patternFor([entry.name]),
        weight: entry.weight,
        antiAffinityGroup: entry.antiAffinityGroup,
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
    let target = -1;
    for (let i = 0; i < shards.length; i++) {
      const shard = shards[i]!;
      if (entry.unit.antiAffinityGroup && shard.units.some((unit) => unit.antiAffinityGroup === entry.unit.antiAffinityGroup)) continue;
      const best = target >= 0 ? shards[target]! : undefined;
      if (!best || shard.weight < best.weight || (shard.weight === best.weight && i < target)) {
        target = i;
      }
    }
    if (target < 0) {
      throw new Error(`cannot place ${entry.unit.label}: anti-affinity group ${entry.unit.antiAffinityGroup} exceeds ${shardCount} shards`);
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
        if (count > 0 && !SPLIT_FILES.has(file)) duplicates.push(file);
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
  for (const file of SPLIT_FILES.keys()) {
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

  const dedicatedErrors: string[] = [];
  for (const [file, configured] of DEDICATED_TESTS) {
    for (const entry of configured) {
      const emitted = shards.flatMap((shard) => shard.units).filter((unit) => unit.files[0] === file && unit.names?.includes(entry.name));
      if (emitted.length !== 1 || emitted[0]?.antiAffinityGroup !== entry.antiAffinityGroup) {
        dedicatedErrors.push(`${file}: ${entry.name}: emitted ${emitted.length} times with expected anti-affinity`);
      }
    }
  }
  for (const [file, antiAffinityGroup] of WHOLE_FILE_ANTI_AFFINITY) {
    const emitted = shards.flatMap((shard) => shard.units).filter((unit) => unit.label === file && unit.files.length === 1 && unit.files[0] === file);
    if (emitted.length !== 1 || emitted[0]?.antiAffinityGroup !== antiAffinityGroup) {
      dedicatedErrors.push(`${file}: emitted ${emitted.length} times with expected anti-affinity`);
    }
  }
  const affinityErrors: string[] = [];
  for (let i = 0; i < shards.length; i++) {
    const groups = new Map<string, number>();
    for (const unit of shards[i]!.units) {
      if (unit.antiAffinityGroup) groups.set(unit.antiAffinityGroup, (groups.get(unit.antiAffinityGroup) ?? 0) + 1);
    }
    for (const [group, count] of groups) {
      if (count > 1) affinityErrors.push(`shard ${i}: anti-affinity group ${group} appears ${count} times`);
    }
  }

  if (missing.length || duplicates.length || extra.length || empty.length || splitErrors.length || dedicatedErrors.length || affinityErrors.length) {
    if (missing.length) console.error(`missing files:\n${missing.join("\n")}`);
    if (duplicates.length) console.error(`duplicate files:\n${duplicates.join("\n")}`);
    if (extra.length) console.error(`extra files:\n${extra.join("\n")}`);
    if (empty.length) console.error(`empty shards: ${empty.join(", ")}`);
    if (splitErrors.length) console.error(`split coverage errors:\n${splitErrors.join("\n")}`);
    if (dedicatedErrors.length) console.error(`dedicated test errors:\n${dedicatedErrors.join("\n")}`);
    if (affinityErrors.length) console.error(`anti-affinity errors:\n${affinityErrors.join("\n")}`);
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
    console.log(`shard ${i}/${shardCount}: ${shard.units.length} units, weight ${shard.weight.toFixed(1)}`);
    for (const unit of shard.units) {
      const split = unit.pattern ? ` (${unit.files[0]}, split, w=${unit.weight})` : FILE_WEIGHTS.has(unit.label) ? ` (w=${FILE_WEIGHTS.get(unit.label)})` : "";
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
