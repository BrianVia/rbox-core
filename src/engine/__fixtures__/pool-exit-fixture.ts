import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RBOX_CRYPTO_WORKERS = "1";
process.env.RBOX_CRYPTO_POOL_MIN_JOBS = "1";

const {
  cryptoPoolStatus,
  encryptFileToTemp,
  generateKek,
  shutdownCryptoPool,
  withCryptoPool,
} = await import("../index.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-exit-"));
const ciphertextDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-exit-ct-"));

try {
  const source = path.join(root, "source.txt");
  await fs.writeFile(source, "crypto worker exit regression\n");
  const kek = generateKek();

  await withCryptoPool(kek, 1, 1, async () => {
    await encryptFileToTemp(source, kek, ciphertextDir, { compress: false });
  });

  if (cryptoPoolStatus().workerExecutions < 1) {
    throw new Error("fixture did not execute encryption in a crypto worker");
  }

  await shutdownCryptoPool();
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(ciphertextDir, { recursive: true, force: true });
}
