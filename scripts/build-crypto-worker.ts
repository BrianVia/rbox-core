import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
export const CRYPTO_WORKER_BUNDLE = path.join(ROOT, "src", "engine", "generated", "crypto-worker.bundle.js");

export function buildCryptoWorkerBundle(): void {
  fs.mkdirSync(path.dirname(CRYPTO_WORKER_BUNDLE), { recursive: true });
  const r = Bun.spawnSync(
    [
      "bun",
      "build",
      "./src/engine/crypto-worker.ts",
      "--target=bun",
      "--outfile",
      path.relative(ROOT, CRYPTO_WORKER_BUNDLE),
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" }
  );
  if (r.exitCode !== 0) throw new Error("crypto worker bundle build failed");
}

if (import.meta.main) {
  try {
    buildCryptoWorkerBundle();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
