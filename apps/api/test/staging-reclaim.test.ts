import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { gcStagingSweep, STAGING_ORPHAN_MIN_AGE_MS } from "../src/versions.js";

// Regression: `staging/` R2 objects had NO reclaimer. R2's 7-day multipart TTL only covers
// INCOMPLETE uploads; after `mpu.complete()` the staging key is an ordinary TTL-free object
// whose sole handle is the `uploads` row that multipart cleanup drops. gcMark rotates only
// `blobs/sha256/` + `manifests/sha256/`, so an orphan there leaked permanently.

const db = () => env.rbox_dev_db;
let seq = 0;

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

/** A REAL completed staging object: created and assembled exactly as multipartInit/Complete do. */
async function stagingObject(label: string): Promise<string> {
  const key = `staging/${"0".repeat(64)}/reclaim-${label}-${seq++}`;
  const mpu = await env.rbox_dev_blobs.createMultipartUpload(key);
  const part = await mpu.uploadPart(1, new TextEncoder().encode(`staged bytes for ${label}`));
  await mpu.complete([part]);
  expect(await env.rbox_dev_blobs.head(key)).not.toBeNull();
  return key;
}

async function uploadsRow(stagingKey: string): Promise<void> {
  await db()
    .prepare("INSERT INTO uploads(upload_id,sha256,staging_key,part_size,total_parts,size,created_at,account_id) VALUES (?,?,?,8,1,8,?,'acct_test')")
    .bind(`up_${stagingKey}`, "0".repeat(64), stagingKey, Date.now())
    .run();
}

const present = (key: string) => env.rbox_dev_blobs.head(key).then((o) => !!o);

describe("staging orphan reclaimer", () => {
  test("reclaims an aged staging object whose uploads row is gone", async () => {
    const orphan = await stagingObject("orphan");
    const body = (await (await gcStagingSweep(env, Date.now() + STAGING_ORPHAN_MIN_AGE_MS + 1)).json()) as { deleted: number };

    expect(await present(orphan)).toBe(false);
    expect(body.deleted).toBeGreaterThanOrEqual(1);
  });

  test("never reclaims an object whose uploads row still exists (the liveness signal)", async () => {
    const live = await stagingObject("live");
    await uploadsRow(live);

    await gcStagingSweep(env, Date.now() + STAGING_ORPHAN_MIN_AGE_MS + 1);
    expect(await present(live)).toBe(true);

    // Dropping the handle is what makes it an orphan — the very next sweep reclaims it.
    await db().prepare("DELETE FROM uploads WHERE staging_key=?").bind(live).run();
    await gcStagingSweep(env, Date.now() + STAGING_ORPHAN_MIN_AGE_MS + 1);
    expect(await present(live)).toBe(false);
  });

  test("never reclaims an object below the age floor, even with no uploads row", async () => {
    const fresh = await stagingObject("fresh");

    await gcStagingSweep(env, Date.now() + STAGING_ORPHAN_MIN_AGE_MS - 60_000);
    expect(await present(fresh)).toBe(true);
  });

  test("fails closed: an unreadable liveness lookup reclaims nothing", async () => {
    const orphan = await stagingObject("failclosed");
    const failing = new Proxy(db(), {
      get(target, property, receiver) {
        if (property === "batch") return async () => { throw new Error("injected liveness failure"); };
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(gcStagingSweep({ ...env, rbox_dev_db: failing } as typeof env, Date.now() + STAGING_ORPHAN_MIN_AGE_MS + 1)).rejects.toThrow("injected");
    expect(await present(orphan)).toBe(true);
  });
});
