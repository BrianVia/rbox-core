import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";

const BASE = "https://example.com";
const db = () => env.rbox_dev_db;

interface BootstrappedAccount {
  token: string;
  accountId: string;
}

interface VersionRow {
  sequence: number;
  commit_hash: string;
  device_id: string | null;
  created_at: number;
}

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(label: string): Promise<BootstrappedAccount> {
  const response = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: "test-bootstrap-secret",
      accountName: `version-history-${label}-${crypto.randomUUID()}`,
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<BootstrappedAccount>;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function versions(
  token: string,
  workspaceId: string,
  projectId: string,
  limit?: string,
): Promise<Response> {
  const query = limit === undefined ? "" : `?limit=${encodeURIComponent(limit)}`;
  return SELF.fetch(`${BASE}/v1/ws/${workspaceId}/proj/${projectId}/versions${query}`, {
    headers: auth(token),
  });
}

describe("GET /v1/ws/:ws/proj/:proj/versions", () => {
  test("authorizes before reading and preserves account scope, descending shape, and limit fallback", async () => {
    const owner = await bootstrap("owner");
    const outsider = await bootstrap("outsider");
    const workspaceId = `ws_versions_${crypto.randomUUID().replace(/-/g, "")}`;
    const projectId = "root";
    const otherProjectId = "other";
    const createdBase = 1_900_000_000_000;

    await db().batch([
      db()
        .prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(workspaceId, projectId, owner.accountId, createdBase),
      db()
        .prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(workspaceId, otherProjectId, owner.accountId, createdBase),
      ...Array.from({ length: 55 }, (_, index) => {
        const sequence = index + 1;
        return db()
          .prepare(
            "INSERT INTO commits (workspace_id, project_id, sequence, commit_hash, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            workspaceId,
            projectId,
            sequence,
            `commit-${sequence}`,
            sequence === 55 ? null : `device-${sequence}`,
            createdBase + sequence,
          );
      }),
      db()
        .prepare(
          "INSERT INTO commits (workspace_id, project_id, sequence, commit_hash, device_id, created_at) VALUES (?, ?, 999, 'other-project', 'other-device', ?)",
        )
        .bind(workspaceId, otherProjectId, createdBase + 999),
    ]);

    // Existing commit rows must not make a workspace enumerable cross-account.
    const denied = await versions(outsider.token, workspaceId, projectId);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "not_found" });

    const defaultResponse = await versions(owner.token, workspaceId, projectId);
    expect(defaultResponse.status).toBe(200);
    const defaultRows = (await defaultResponse.json()) as { versions: VersionRow[] };
    expect(defaultRows.versions).toHaveLength(50);
    expect(defaultRows.versions.map((row) => row.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => 55 - index),
    );
    expect(defaultRows.versions[0]).toEqual({
      sequence: 55,
      commit_hash: "commit-55",
      device_id: null,
      created_at: createdBase + 55,
    });
    expect(defaultRows.versions.some((row) => row.commit_hash === "other-project")).toBe(false);

    const limited = await versions(owner.token, workspaceId, projectId, "3");
    expect(limited.status).toBe(200);
    expect(((await limited.json()) as { versions: VersionRow[] }).versions.map((row) => row.sequence)).toEqual([
      55,
      54,
      53,
    ]);

    for (const invalid of ["junk", "0", "501"]) {
      const fallback = await versions(owner.token, workspaceId, projectId, invalid);
      expect(fallback.status, invalid).toBe(200);
      expect(((await fallback.json()) as { versions: VersionRow[] }).versions, invalid).toHaveLength(50);
    }
  });
});
