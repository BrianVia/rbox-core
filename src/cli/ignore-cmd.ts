import fs from "node:fs/promises";
import path from "node:path";
import { effectiveIgnoreRules } from "../engine/index.js";

const RBOXIGNORE = ".rboxignore";

/** Append a pattern to `.rboxignore` (synced, shared across machines), de-duped. */
export async function addIgnorePattern(root: string, pattern: string): Promise<void> {
  const file = path.join(root, RBOXIGNORE);
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    /* new file */
  }
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(pattern.trim())) {
    console.log(`already ignored: ${pattern}`);
    return;
  }
  const next = existing && !existing.endsWith("\n") ? `${existing}\n${pattern}\n` : `${existing}${pattern}\n`;
  await fs.writeFile(file, next);
  console.log(`added to ${RBOXIGNORE}: ${pattern}`);
  console.log(`(forward-only: already-synced matches keep their last copy on other machines and stop syncing.`);
  console.log(` to remove a file from all machines, delete it FIRST, let that sync, then ignore it.)`);
}

/** Print the effective ignore rule set, labeled by source, in precedence order. */
export function listIgnoreRules(root: string): void {
  const rules = effectiveIgnoreRules(root);
  console.log(`effective ignore rules (precedence: builtin → .gitignore → .rboxignore):`);
  for (const r of rules) console.log(`  [${r.source}] ${r.pattern}`);
}
