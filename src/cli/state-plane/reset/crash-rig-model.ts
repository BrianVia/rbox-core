/**
 * Tiny durable-device model for reset crash fixtures.
 *
 * Working namespace changes become power-safe only after fsyncDir(). File
 * contents become power-safe only after fsyncFile(). A power cut therefore
 * reconstructs names from durable directory entries and bytes from durable
 * inode images, discarding every other write.
 *
 * Never: production filesystem behavior.
 */
export class DurableTree {
  private nextInode = 1;
  private readonly workingNames = new Map<string, number>();
  private readonly durableNames = new Map<string, number>();
  private readonly workingBytes = new Map<number, Uint8Array>();
  private readonly durableBytes = new Map<number, Uint8Array>();

  seed(path: string, bytes: string | Uint8Array): void {
    const inode = this.nextInode++;
    const value = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes.slice();
    this.workingNames.set(path, inode);
    this.durableNames.set(path, inode);
    this.workingBytes.set(inode, value);
    this.durableBytes.set(inode, value.slice());
  }

  write(path: string, bytes: string | Uint8Array): void {
    let inode = this.workingNames.get(path);
    if (inode === undefined) {
      inode = this.nextInode++;
      this.workingNames.set(path, inode);
    }
    this.workingBytes.set(inode, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes.slice());
  }

  fsyncFile(path: string): void {
    const inode = this.workingNames.get(path);
    const bytes = inode === undefined ? undefined : this.workingBytes.get(inode);
    if (inode === undefined || bytes === undefined) throw new Error(`cannot fsync absent file ${path}`);
    this.durableBytes.set(inode, bytes.slice());
  }

  rename(source: string, destination: string): void {
    const inode = this.workingNames.get(source);
    if (inode === undefined) throw new Error(`cannot rename absent file ${source}`);
    this.workingNames.delete(source);
    this.workingNames.set(destination, inode);
  }

  unlink(path: string): void {
    this.workingNames.delete(path);
  }

  /** Commit the namespace entries in exactly one parent directory. */
  fsyncDir(parent: string): void {
    const prefix = parent === "." ? "" : `${parent}/`;
    const direct = (file: string): boolean => {
      if (!file.startsWith(prefix)) return false;
      return !file.slice(prefix.length).includes("/");
    };
    for (const file of [...this.durableNames.keys()]) {
      if (direct(file)) this.durableNames.delete(file);
    }
    for (const [file, inode] of this.workingNames) {
      if (direct(file)) this.durableNames.set(file, inode);
    }
  }

  powerCut(): Record<string, string> {
    return Object.fromEntries([...this.durableNames.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, inode]) => {
        const bytes = this.durableBytes.get(inode);
        return [file, bytes === undefined ? "" : Buffer.from(bytes).toString("hex")];
      }));
  }
}

export type ModeledResetRow =
  | "P0" | "P1" | "P2" | `P3.${number}` | "R0" | "R1" | "R2"
  | "I0" | "I2" | `I3.${number}` | "Z0" | "steady" | "halt";

const text = (tree: Record<string, string>, file: string): string | undefined => {
  const hex = tree[file];
  return hex === undefined ? undefined : Buffer.from(hex, "hex").toString("utf8");
};

/** Closed zero-ref physical classifier used only to assert modeled snapshots. */
export function classifyModeledZeroRefTree(tree: Record<string, string>): ModeledResetRow {
  const journal = text(tree, "state/reset-v1.json");
  const active = text(tree, "state/state.db");
  const candidate = text(tree, "state/reset-candidates/id.db");
  const archive = text(tree, "state/lineages/nonce/old.db");
  const marker = text(tree, "state/state-incarnation.json");
  const zCount = Number(text(tree, "meta/z-count") ?? "0");
  const groupCount = Number(text(tree, "meta/group-count") ?? "0");
  let recovery = 0;
  while (text(tree, `refs/recovery/${recovery + 1}`) === "target") recovery++;
  let retired = 0;
  while (text(tree, `refs/active/${retired + 1}`) === undefined && retired < groupCount) retired++;
  if (!journal) return active === "N" && candidate === undefined ? "steady" : "halt";
  if (!["prepared", "ready", "installed", "z-retired"].includes(journal)) return "halt";
  if (journal === "prepared" && active === "O" && candidate === undefined && archive === undefined) return "P0";
  if (journal === "prepared" && active === "O" && candidate === "N" && archive === undefined) return "P1";
  if (journal === "prepared" && active === "O" && candidate === "N" && archive === "O") {
    if (recovery === 0) return "P2";
    if (recovery <= zCount) return `P3.${recovery}`;
  }
  if (journal === "ready" && active === "O" && candidate === "N" && archive === "O" && recovery === zCount) return "R0";
  if (journal === "ready" && active === "N" && candidate === undefined && archive === "O") return "R1";
  if (journal === "ready" && active === "N" && candidate === "N" && archive === "O") return "R2";
  if (journal === "installed" && active === "N" && candidate === undefined && archive === "O") {
    if (recovery !== zCount) return "halt";
    if (marker !== "MN") return "I0";
    return retired === 0 ? "I2" : retired <= groupCount ? `I3.${retired}` : "halt";
  }
  if (journal === "z-retired" && active === "N" && candidate === undefined && archive === "O"
    && marker === "MN" && recovery === zCount && retired === groupCount) return "Z0";
  return "halt";
}
