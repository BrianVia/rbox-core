import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cryptoPoolStatus, encryptFileToTemp, generateKek, withCryptoPool } from "../engine/index.js";
import { emitJson } from "./json.js";

export async function cryptoSmoke(opts: { jobs?: number } = {}): Promise<number> {
  const jobs = Number.isInteger(opts.jobs) && opts.jobs! > 0 ? opts.jobs! : 8;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-crypto-smoke-"));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-crypto-smoke-ct-"));
  try {
    const kek = generateKek();
    const files: string[] = [];
    for (let i = 0; i < jobs; i++) {
      const file = path.join(root, `file-${i}.txt`);
      await fs.writeFile(file, Buffer.from(`crypto smoke ${i}\n`.repeat(200)));
      files.push(file);
    }
    await withCryptoPool(kek, 0, files.length, async () => {
      await Promise.all(files.map((file) => encryptFileToTemp(file, kek, tmpDir, { compress: true })));
    });
    const status = cryptoPoolStatus();
    emitJson({ ok: status.workerExecutions > 0, status });
    return status.workerExecutions > 0 ? 0 : 1;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
