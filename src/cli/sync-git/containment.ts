import fs from "node:fs/promises";
import path from "node:path";

// ---- apply-target containment (design 43 §7 [v2, B5; v3]) ------------------------

/**
 * Refuse a git materialization/apply target that escapes the workspace root. Every
 * EXISTING path component from root → target is lstat-checked (no symlink components —
 * a symlinked parent smuggled via the file manifest must not redirect a repo
 * materialization outside the workspace), and the deepest existing prefix's realpath
 * must stay inside the root's realpath. Callers re-run this immediately after
 * `git init` (cheap belt-and-braces re-verify); a *local*-attacker race between check
 * and init is explicitly out of the threat model. Throws on violation; returns the
 * absolute target path (`root` itself for relPath "."). Exported for STEP 3.
 */
export async function assertGitTargetWithinRoot(root: string, relPath: string): Promise<string> {
  const rootReal = await fs.realpath(root);
  if (relPath === ".") return root;
  const abs = path.join(root, relPath);
  let probe = root;
  for (const seg of relPath.split("/")) {
    probe = path.join(probe, seg);
    let st;
    try {
      st = await fs.lstat(probe);
    } catch {
      break; // rest doesn't exist yet — it will be created under the verified prefix
    }
    if (st.isSymbolicLink()) throw new Error(`git apply target has a symlink component: ${probe}`);
  }
  // Belt-and-braces: realpath of the deepest existing prefix must stay inside the root.
  let existing = abs;
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`git apply target escapes workspace root: ${abs}`);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return abs;
}
