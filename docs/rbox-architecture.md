> STALE (2026-08-11): superseded by `rbox-architecture-v2.md` and `docs/CODEMAP.md`; kept pending founder deletion decision. This is the pre-rename "CodeSync" v1 draft — the product name, binary, CLI surface, HTTP routes, D1 schema, R2 layout, wrangler config, repo layout and local-state paths in it are all contradicted by the current code.

# CodeSync Architecture

## Overview

CodeSync is a developer-aware sync system for source folders.

Unlike Dropbox, Syncthing, iCloud Drive, or rsync, CodeSync understands that a development project contains two different classes of files:

1. **Portable source-of-truth files**
   - Source code
   - Lockfiles
   - Config files
   - Docs
   - Scripts
   - Project metadata

2. **Machine-local files**
   - `node_modules`
   - `.venv`
   - `target`
   - `dist`
   - `.next`
   - `.turbo`
   - `.cache`
   - `.env`
   - Native compiled dependencies
   - Local database files
   - OS/editor junk

CodeSync should sync the first category and regenerate, ignore, or preserve the second category per machine.

The MVP thesis:

> CodeSync keeps source code portable across machines while treating dependencies, build outputs, secrets, and machine-specific files as local state.

The first product wedge is not generic file sync. It is:

```bash
codesync init ~/code
codesync scan
codesync status
codesync hydrate project-a
codesync doctor
```

---

# Product Goal

CodeSync should answer:

```txt
Can this project safely move to another machine?
What files should not sync?
What do I need to run after syncing?
What local secrets or dependencies are missing?
```

The important product distinction:

> Sync source, configs, and project metadata. Do not sync generated/runtime/vendor state. Rehydrate that state per machine.

For example, in a Node project:

```txt
~/code/project-a/
  src/
  package.json
  package-lock.json
  node_modules/   <-- do not sync
```

CodeSync should sync:

```txt
src/
package.json
package-lock.json
tsconfig.json
README.md
.env.example
```

CodeSync should exclude:

```txt
node_modules/
dist/
.next/
.cache/
coverage/
.env
```

Then on each machine, CodeSync should run or suggest:

```bash
npm ci
# or pnpm install
# or yarn install
```

---

# Key Design Principle

CodeSync should never think in terms of “sync user’s path.”

It should think in terms of:

```txt
Account
  Workspace
    Project
      Manifest
        File entries
          Blob hashes
```

A file path like:

```txt
~/code/project-a/src/index.ts
```

is client-local state.

Server-side, it becomes:

```txt
account_id
workspace_id
project_id
relative_path = "src/index.ts"
blob_sha256 = "abc123..."
```

That distinction matters for security, portability, and multi-user support.

---

# Cloudflare Stack

Assume CodeSync is built on Cloudflare from day one.

Recommended stack:

```txt
Workers       API layer
D1            relational metadata/control plane
R2            content-addressed file blobs
Queues        async jobs
Durable Objects workspace-level live sync coordination
```

Strong opinion:

> Do not put sync state only in R2 object keys. R2 is for bytes. D1 is for account/project/device metadata and manifests.

---

## Workers

Workers serve the public API:

```txt
POST /v1/auth/session
POST /v1/workspaces
GET  /v1/workspaces
POST /v1/devices/register
POST /v1/workspaces/:workspaceId/projects
POST /v1/workspaces/:workspaceId/projects/:projectId/manifests
POST /v1/blobs/upload-url
PUT  /v1/blobs
POST /v1/blobs/commit
GET  /v1/workspaces/:workspaceId/projects/:projectId/latest
GET  /v1/sync/pull
POST /v1/sync/push
GET  /v1/devices
```

The Worker should be thin:

```txt
auth
validate input
check account/workspace membership
write metadata to D1
read/write blobs from R2
enqueue background jobs
route live sync events to Durable Objects later
```

---

## D1

Use D1 for:

```txt
users
accounts
account_memberships
devices
workspaces
workspace_memberships
projects
manifests
manifest_files
blobs
blob_refs
sync_events
audit_log
```

D1 is the control plane.

---

## R2

Use R2 for content-addressed blobs:

```txt
blobs/sha256/ab/abcdef...
```

Do **not** store blobs under user path names.

This gives CodeSync:

```txt
dedupe across the same account
safe multi-device sync
immutable blob objects
cheap integrity verification
eventual per-account quota accounting
```

Whether to dedupe globally across accounts is a product/security decision. For MVP, do **not expose global dedupe semantics**. Internally, content-addressing is fine, but quota/ref accounting must be account-scoped.

---

## Queues

Use Queues for:

```txt
manifest processing
quota calculation
garbage collection
virus/malware scanning later
large workspace indexing
background compaction
device notification fanout
```

---

## Durable Objects

Use Durable Objects for:

```txt
workspace-level live sync coordination
WebSocket sessions
per-workspace sequencing
conflict serialization
presence: "MacBook is online"
```

Do **not** use Durable Objects as the primary account database.

Use them surgically.

Example:

```txt
WorkspaceSyncObject(workspace_id)
  connected devices
  recent sync sequence
  broadcast changed manifest/version
```

---

# Core Concepts

## Account

A billing/security container.

An account can have many users, devices, workspaces, and projects.

## User

A human identity.

Users belong to accounts through account memberships.

## Device

A specific machine running CodeSync.

Example host facts:

```json
{
  "hostId": "macbook-pro-brian",
  "platform": "darwin",
  "arch": "arm64",
  "home": "/Users/brian",
  "shell": "/bin/zsh",
  "node": "22.3.0",
  "pnpm": "9.1.0",
  "docker": true
}
```

## Workspace

A root directory managed by CodeSync.

Example:

```txt
~/code
  project-a/
  project-b/
  project-c/
```

The local workspace has:

```txt
~/code/.codesync/
  workspace.json
```

Global local state lives at:

```txt
~/.codesync/
  hosts/
  projects/
  cache/
  logs/
```

## Project

A detected or registered codebase inside a workspace.

A project can be detected by files such as:

```txt
package.json
pnpm-lock.yaml
yarn.lock
package-lock.json
Cargo.toml
pyproject.toml
requirements.txt
go.mod
deno.json
bun.lockb
docker-compose.yml
```

A project may optionally define:

```txt
.codesync.yml
```

## Manifest

A manifest is a point-in-time list of syncable files for a project.

It contains relative paths, hashes, file metadata, and tombstones for deleted files.

## Blob

A blob is immutable file content stored in R2 by SHA-256 hash.

## Hydration

Hydration means making a synced project runnable on the current machine.

Examples:

```bash
npm ci
pnpm install
python -m venv .venv && pip install -r requirements.txt
cargo fetch
go mod download
docker compose pull
```

Hydration should be deterministic and based on lockfiles where possible.

---

# Multi-User Data Model

Support this from day one:

```txt
User
Account
AccountMembership
Workspace
WorkspaceMembership
Project
Device
Manifest
Blob
```

This supports:

```txt
solo dev
team workspace
company account
shared project
billing later
```

---

# D1 Schema

```sql
-- migrations/0001_init.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE account_memberships (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  public_key TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  detected_type TEXT NOT NULL,
  package_manager TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT,
  UNIQUE (workspace_id, relative_path),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE manifests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  parent_manifest_id TEXT,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE UNIQUE INDEX idx_manifest_project_sequence
ON manifests(project_id, sequence);

CREATE TABLE manifest_files (
  manifest_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_sha256 TEXT,
  size_bytes INTEGER NOT NULL,
  mode TEXT,
  mtime_ms INTEGER,
  file_type TEXT NOT NULL CHECK (file_type IN ('file', 'symlink', 'deleted')),
  symlink_target TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (manifest_id, path),
  FOREIGN KEY (manifest_id) REFERENCES manifests(id)
);

CREATE INDEX idx_manifest_files_blob
ON manifest_files(blob_sha256);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE blob_refs (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 1,
  total_size_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, workspace_id, project_id, blob_sha256),
  FOREIGN KEY (blob_sha256) REFERENCES blobs(sha256)
);

CREATE TABLE sync_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  device_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

# R2 Key Design

Use content addressing.

```ts
export function blobKeyFromSha256(sha256: string): string {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}
```

Example:

```txt
blobs/sha256/ab/abcdef123456...
```

Temporary uploads:

```txt
tmp/uploads/{accountId}/{uploadId}
```

Exported snapshots:

```txt
accounts/{accountId}/workspaces/{workspaceId}/snapshots/{snapshotId}.json
```

Actual file content should be hash-addressed.

---

# Wrangler Config

```jsonc
// wrangler.jsonc
{
  "name": "codesync-api",
  "main": "src/worker.ts",
  "compatibility_date": "2026-06-23",
  "compatibility_flags": ["nodejs_compat"],

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "codesync",
      "database_id": "REPLACE_ME"
    }
  ],

  "r2_buckets": [
    {
      "binding": "BLOBS",
      "bucket_name": "codesync-blobs"
    }
  ],

  "queues": {
    "producers": [
      {
        "binding": "SYNC_QUEUE",
        "queue": "codesync-sync-events"
      }
    ],
    "consumers": [
      {
        "queue": "codesync-sync-events"
      }
    ]
  },

  "durable_objects": {
    "bindings": [
      {
        "name": "WORKSPACE_SYNC",
        "class_name": "WorkspaceSyncObject"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["WorkspaceSyncObject"]
    }
  ]
}
```

---

# Suggested Monorepo

```txt
codesync/
  apps/
    api/
      src/
        worker.ts
        env.ts
        http.ts
        workspace-sync-object.ts
        routes/
        security/
        storage/
      migrations/
      wrangler.jsonc

    cli/
      src/
        cli.ts
        commands/
        core/
        api/
      package.json

  packages/
    shared/
      src/
        protocol.ts
        manifest.ts
        hashing.ts
        ignore-defaults.ts
```

---

# API Worker Environment Types

```ts
// apps/api/src/env.ts
export type Env = {
  DB: D1Database;
  BLOBS: R2Bucket;
  SYNC_QUEUE: Queue<SyncQueueMessage>;
  WORKSPACE_SYNC: DurableObjectNamespace<WorkspaceSyncObject>;
  JWT_SECRET: string;
};

export type SyncQueueMessage =
  | {
      type: "manifest.created";
      accountId: string;
      workspaceId: string;
      projectId: string;
      manifestId: string;
    }
  | {
      type: "blob.committed";
      accountId: string;
      sha256: string;
      sizeBytes: number;
    };
```

---

# Shared Protocol Types

```ts
// packages/shared/src/protocol.ts
export type ManifestFileEntry = {
  path: string;
  sha256?: string;
  sizeBytes: number;
  mode?: string;
  mtimeMs?: number;
  fileType: "file" | "symlink" | "deleted";
  symlinkTarget?: string;
};

export type CommitManifestRequest = {
  deviceId: string;
  parentManifestId?: string | null;
  files: ManifestFileEntry[];
};

export type CommitManifestResponse = {
  manifest: {
    id: string;
    sequence: number;
  };
};
```

---

# API Shape

## Create Workspace

```http
POST /v1/workspaces
Authorization: Bearer <token>
Content-Type: application/json

{
  "accountId": "acc_123",
  "name": "Brian's Code"
}
```

Response:

```json
{
  "workspace": {
    "id": "ws_123",
    "accountId": "acc_123",
    "name": "Brian's Code"
  }
}
```

## Register Device

```http
POST /v1/devices/register
Authorization: Bearer <token>

{
  "accountId": "acc_123",
  "name": "Brian MacBook Pro",
  "platform": "darwin",
  "arch": "arm64",
  "publicKey": "optional-device-public-key"
}
```

## Commit Manifest

```http
POST /v1/workspaces/ws_123/projects/proj_123/manifests
Authorization: Bearer <token>

{
  "deviceId": "dev_123",
  "parentManifestId": "man_prev",
  "files": [
    {
      "path": "package.json",
      "sha256": "abc123...",
      "sizeBytes": 1234,
      "mtimeMs": 1780000000000,
      "fileType": "file"
    },
    {
      "path": "node_modules",
      "fileType": "deleted",
      "sizeBytes": 0
    }
  ]
}
```

## Pull Latest Manifest

```http
GET /v1/workspaces/ws_123/projects/proj_123/latest
Authorization: Bearer <token>
```

---

# Worker Router Skeleton

```ts
// apps/api/src/worker.ts
import { WorkspaceSyncObject } from "./workspace-sync-object";
import type { Env } from "./env";
import { json, notFound } from "./http";
import { requireAuth } from "./security/auth";
import { createWorkspace } from "./routes/create-workspace";
import { registerDevice } from "./routes/register-device";
import { commitManifest } from "./routes/commit-manifest";
import { getLatestManifest } from "./routes/get-latest-manifest";
import { uploadBlob } from "./routes/upload-blob";

export { WorkspaceSyncObject };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({ ok: true });
    }

    const auth = await requireAuth(request, env);

    if (request.method === "POST" && path === "/v1/workspaces") {
      return createWorkspace(request, env, auth);
    }

    if (request.method === "POST" && path === "/v1/devices/register") {
      return registerDevice(request, env, auth);
    }

    const commitMatch = path.match(
      /^\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/manifests$/
    );

    if (request.method === "POST" && commitMatch) {
      return commitManifest(request, env, auth, {
        workspaceId: commitMatch[1],
        projectId: commitMatch[2]
      });
    }

    const latestMatch = path.match(
      /^\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/latest$/
    );

    if (request.method === "GET" && latestMatch) {
      return getLatestManifest(request, env, auth, {
        workspaceId: latestMatch[1],
        projectId: latestMatch[2]
      });
    }

    if (request.method === "PUT" && path === "/v1/blobs") {
      return uploadBlob(request, env, auth);
    }

    return notFound();
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      console.log("queue message", message.body);
      message.ack();
    }
  }
};
```

---

# HTTP Helpers

```ts
// apps/api/src/http.ts
export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
}

export function notFound(): Response {
  return json({ error: "not_found" }, { status: 404 });
}

export function forbidden(message = "Forbidden"): Response {
  return json({ error: "forbidden", message }, { status: 403 });
}

export function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, { status: 400 });
}

export function unauthorized(message: string): Response {
  return json({ error: "unauthorized", message }, { status: 401 });
}
```

---

# Auth Model

Recommended MVP options:

## Option A: Clerk/Auth0/Supabase Auth

Fastest for SaaS. Worker verifies JWT.

## Option B: Cloudflare Access

Good for internal/beta usage, less ideal for consumer SaaS.

## Option C: First-party Auth

More work. Avoid initially unless auth itself is part of the product.

For multi-user SaaS, use external auth at first and map JWT subject to `users.id`.

```ts
// apps/api/src/security/auth.ts
import type { Env } from "../env";
import { unauthorized } from "../http";

export type AuthContext = {
  userId: string;
  email: string;
};

export async function requireAuth(
  request: Request,
  env: Env
): Promise<AuthContext> {
  const header = request.headers.get("authorization");

  if (!header?.startsWith("Bearer ")) {
    throw unauthorized("Missing bearer token");
  }

  const token = header.slice("Bearer ".length);

  // MVP placeholder.
  // Replace with real JWT verification using jose or your auth provider.
  if (token === "dev") {
    return {
      userId: "usr_dev",
      email: "dev@example.com"
    };
  }

  throw unauthorized("Invalid token");
}
```

---

# Membership Checks

Every route should check account/workspace access.

```ts
// apps/api/src/security/access.ts
import type { Env } from "../env";

export async function assertWorkspaceAccess(args: {
  env: Env;
  userId: string;
  workspaceId: string;
  minRole: "viewer" | "editor" | "owner";
}) {
  const row = await args.env.DB.prepare(
    `
    SELECT wm.role
    FROM workspace_memberships wm
    WHERE wm.workspace_id = ?
      AND wm.user_id = ?
    `
  )
    .bind(args.workspaceId, args.userId)
    .first<{ role: string }>();

  if (!row) {
    throw new Response(
      JSON.stringify({ error: "forbidden", message: "No workspace access" }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }

  const rank = {
    viewer: 1,
    editor: 2,
    owner: 3
  };

  if (rank[row.role as keyof typeof rank] < rank[args.minRole]) {
    throw new Response(
      JSON.stringify({ error: "forbidden", message: "Insufficient role" }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }
}
```

---

# Create Workspace Route

```ts
// apps/api/src/routes/create-workspace.ts
import { z } from "zod";
import type { Env } from "../env";
import type { AuthContext } from "../security/auth";
import { json, badRequest } from "../http";

const CreateWorkspaceBody = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(120)
});

export async function createWorkspace(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const parsed = CreateWorkspaceBody.safeParse(await request.json());

  if (!parsed.success) {
    return badRequest(parsed.error.message);
  }

  const workspaceId = crypto.randomUUID();

  const hasAccountAccess = await env.DB.prepare(
    `
    SELECT 1
    FROM account_memberships
    WHERE account_id = ?
      AND user_id = ?
      AND role IN ('owner', 'admin', 'member')
    `
  )
    .bind(parsed.data.accountId, auth.userId)
    .first();

  if (!hasAccountAccess) {
    return json({ error: "forbidden" }, { status: 403 });
  }

  await env.DB.batch([
    env.DB.prepare(
      `
      INSERT INTO workspaces (id, account_id, name, created_by_user_id)
      VALUES (?, ?, ?, ?)
      `
    ).bind(workspaceId, parsed.data.accountId, parsed.data.name, auth.userId),

    env.DB.prepare(
      `
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (?, ?, 'owner')
      `
    ).bind(workspaceId, auth.userId)
  ]);

  return json({
    workspace: {
      id: workspaceId,
      accountId: parsed.data.accountId,
      name: parsed.data.name
    }
  });
}
```

---

# Register Device Route

```ts
// apps/api/src/routes/register-device.ts
import { z } from "zod";
import type { Env } from "../env";
import type { AuthContext } from "../security/auth";
import { badRequest, json } from "../http";

const RegisterDeviceBody = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(120),
  platform: z.string().min(1),
  arch: z.string().min(1),
  publicKey: z.string().optional()
});

export async function registerDevice(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const parsed = RegisterDeviceBody.safeParse(await request.json());

  if (!parsed.success) {
    return badRequest(parsed.error.message);
  }

  const access = await env.DB.prepare(
    `
    SELECT 1
    FROM account_memberships
    WHERE account_id = ?
      AND user_id = ?
    `
  )
    .bind(parsed.data.accountId, auth.userId)
    .first();

  if (!access) {
    return json({ error: "forbidden" }, { status: 403 });
  }

  const deviceId = crypto.randomUUID();

  await env.DB.prepare(
    `
    INSERT INTO devices (
      id,
      account_id,
      user_id,
      name,
      platform,
      arch,
      public_key,
      last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `
  )
    .bind(
      deviceId,
      parsed.data.accountId,
      auth.userId,
      parsed.data.name,
      parsed.data.platform,
      parsed.data.arch,
      parsed.data.publicKey ?? null
    )
    .run();

  return json({
    device: {
      id: deviceId,
      accountId: parsed.data.accountId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      arch: parsed.data.arch
    }
  });
}
```

---

# Upload Blob Route

For MVP, the client can `PUT` the blob directly to the Worker. Later, CodeSync may use presigned/direct upload flows, but Worker-mediated upload is simpler and allows hash/size verification.

```ts
// apps/api/src/routes/upload-blob.ts
import type { Env } from "../env";
import type { AuthContext } from "../security/auth";
import { badRequest, json } from "../http";
import { blobKeyFromSha256 } from "../storage/blob-keys";

export async function uploadBlob(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const accountId = request.headers.get("x-codesync-account-id");
  const sha256 = request.headers.get("x-codesync-sha256");
  const sizeHeader = request.headers.get("x-codesync-size");

  if (!accountId || !sha256 || !sizeHeader) {
    return badRequest("Missing account, sha256, or size header");
  }

  const sizeBytes = Number(sizeHeader);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return badRequest("Invalid size");
  }

  const access = await env.DB.prepare(
    `
    SELECT 1
    FROM account_memberships
    WHERE account_id = ?
      AND user_id = ?
    `
  )
    .bind(accountId, auth.userId)
    .first();

  if (!access) {
    return json({ error: "forbidden" }, { status: 403 });
  }

  const existing = await env.DB.prepare(
    `
    SELECT sha256
    FROM blobs
    WHERE sha256 = ?
    `
  )
    .bind(sha256)
    .first();

  if (existing) {
    return json({
      blob: {
        sha256,
        alreadyExists: true
      }
    });
  }

  const body = await request.arrayBuffer();
  const actualHash = await sha256Hex(body);

  if (actualHash !== sha256) {
    return badRequest("SHA-256 mismatch");
  }

  if (body.byteLength !== sizeBytes) {
    return badRequest("Size mismatch");
  }

  const r2Key = blobKeyFromSha256(sha256);

  await env.BLOBS.put(r2Key, body, {
    httpMetadata: {
      contentType: "application/octet-stream"
    },
    customMetadata: {
      sha256,
      uploadedByUserId: auth.userId
    }
  });

  await env.DB.prepare(
    `
    INSERT INTO blobs (sha256, size_bytes, r2_key)
    VALUES (?, ?, ?)
    `
  )
    .bind(sha256, sizeBytes, r2Key)
    .run();

  await env.SYNC_QUEUE.send({
    type: "blob.committed",
    accountId,
    sha256,
    sizeBytes
  });

  return json({
    blob: {
      sha256,
      sizeBytes,
      r2Key,
      alreadyExists: false
    }
  });
}

async function sha256Hex(input: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

---

# Commit Manifest Route

The client should upload all missing blobs first, then commit a manifest that references them.

```ts
// apps/api/src/routes/commit-manifest.ts
import { z } from "zod";
import type { Env } from "../env";
import type { AuthContext } from "../security/auth";
import { badRequest, json } from "../http";
import { assertWorkspaceAccess } from "../security/access";

const ManifestFile = z.object({
  path: z.string().min(1).max(2048),
  sha256: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  mode: z.string().optional(),
  mtimeMs: z.number().int().nonnegative().optional(),
  fileType: z.enum(["file", "symlink", "deleted"]),
  symlinkTarget: z.string().optional()
});

const CommitManifestBody = z.object({
  deviceId: z.string().min(1),
  parentManifestId: z.string().nullable().optional(),
  files: z.array(ManifestFile).max(100_000)
});

export async function commitManifest(
  request: Request,
  env: Env,
  auth: AuthContext,
  params: {
    workspaceId: string;
    projectId: string;
  }
): Promise<Response> {
  const parsed = CommitManifestBody.safeParse(await request.json());

  if (!parsed.success) {
    return badRequest(parsed.error.message);
  }

  await assertWorkspaceAccess({
    env,
    userId: auth.userId,
    workspaceId: params.workspaceId,
    minRole: "editor"
  });

  const project = await env.DB.prepare(
    `
    SELECT account_id
    FROM projects
    WHERE id = ?
      AND workspace_id = ?
      AND archived_at IS NULL
    `
  )
    .bind(params.projectId, params.workspaceId)
    .first<{ account_id: string }>();

  if (!project) {
    return json({ error: "project_not_found" }, { status: 404 });
  }

  const device = await env.DB.prepare(
    `
    SELECT id
    FROM devices
    WHERE id = ?
      AND user_id = ?
      AND account_id = ?
    `
  )
    .bind(parsed.data.deviceId, auth.userId, project.account_id)
    .first();

  if (!device) {
    return json({ error: "device_not_found" }, { status: 404 });
  }

  const missingBlobs = await findMissingBlobs(env, parsed.data.files);

  if (missingBlobs.length > 0) {
    return json(
      {
        error: "missing_blobs",
        missing: missingBlobs
      },
      { status: 409 }
    );
  }

  const latest = await env.DB.prepare(
    `
    SELECT COALESCE(MAX(sequence), 0) AS sequence
    FROM manifests
    WHERE project_id = ?
    `
  )
    .bind(params.projectId)
    .first<{ sequence: number }>();

  const nextSequence = Number(latest?.sequence ?? 0) + 1;
  const manifestId = crypto.randomUUID();

  const statements = [
    env.DB.prepare(
      `
      INSERT INTO manifests (
        id,
        account_id,
        workspace_id,
        project_id,
        device_id,
        parent_manifest_id,
        sequence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).bind(
      manifestId,
      project.account_id,
      params.workspaceId,
      params.projectId,
      parsed.data.deviceId,
      parsed.data.parentManifestId ?? null,
      nextSequence
    )
  ];

  for (const file of parsed.data.files) {
    validateRelativePath(file.path);

    statements.push(
      env.DB.prepare(
        `
        INSERT INTO manifest_files (
          manifest_id,
          account_id,
          workspace_id,
          project_id,
          path,
          blob_sha256,
          size_bytes,
          mode,
          mtime_ms,
          file_type,
          symlink_target
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).bind(
        manifestId,
        project.account_id,
        params.workspaceId,
        params.projectId,
        file.path,
        file.sha256 ?? null,
        file.sizeBytes,
        file.mode ?? null,
        file.mtimeMs ?? null,
        file.fileType,
        file.symlinkTarget ?? null
      )
    );

    if (file.sha256 && file.fileType === "file") {
      statements.push(
        env.DB.prepare(
          `
          INSERT INTO blob_refs (
            account_id,
            workspace_id,
            project_id,
            blob_sha256,
            ref_count,
            total_size_bytes
          )
          VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT(account_id, workspace_id, project_id, blob_sha256)
          DO UPDATE SET
            ref_count = ref_count + 1,
            updated_at = CURRENT_TIMESTAMP
          `
        ).bind(
          project.account_id,
          params.workspaceId,
          params.projectId,
          file.sha256,
          file.sizeBytes
        )
      );
    }
  }

  await env.DB.batch(statements);

  await env.SYNC_QUEUE.send({
    type: "manifest.created",
    accountId: project.account_id,
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    manifestId
  });

  const objectId = env.WORKSPACE_SYNC.idFromName(params.workspaceId);
  const object = env.WORKSPACE_SYNC.get(objectId);

  await object.fetch("https://codesync.internal/broadcast", {
    method: "POST",
    body: JSON.stringify({
      type: "manifest.created",
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      manifestId,
      sequence: nextSequence
    })
  });

  return json({
    manifest: {
      id: manifestId,
      sequence: nextSequence
    }
  });
}

async function findMissingBlobs(
  env: Env,
  files: z.infer<typeof ManifestFile>[]
): Promise<string[]> {
  const hashes = [
    ...new Set(
      files
        .filter((file) => file.fileType === "file")
        .map((file) => file.sha256)
        .filter(Boolean) as string[]
    )
  ];

  const missing: string[] = [];

  for (const hash of hashes) {
    const row = await env.DB.prepare(
      `
      SELECT sha256
      FROM blobs
      WHERE sha256 = ?
      `
    )
      .bind(hash)
      .first();

    if (!row) {
      missing.push(hash);
    }
  }

  return missing;
}

function validateRelativePath(relativePath: string) {
  if (relativePath.startsWith("/")) {
    throw new Error("Path must be relative");
  }

  if (relativePath.includes("..")) {
    throw new Error("Path may not contain ..");
  }

  if (relativePath.includes("\0")) {
    throw new Error("Path may not contain null byte");
  }
}
```

Note: `findMissingBlobs` loops one hash at a time. That is acceptable for a prototype, but it should be chunked/batched before serious use.

---

# Get Latest Manifest Route

```ts
// apps/api/src/routes/get-latest-manifest.ts
import type { Env } from "../env";
import type { AuthContext } from "../security/auth";
import { json } from "../http";
import { assertWorkspaceAccess } from "../security/access";

export async function getLatestManifest(
  request: Request,
  env: Env,
  auth: AuthContext,
  params: {
    workspaceId: string;
    projectId: string;
  }
): Promise<Response> {
  await assertWorkspaceAccess({
    env,
    userId: auth.userId,
    workspaceId: params.workspaceId,
    minRole: "viewer"
  });

  const manifest = await env.DB.prepare(
    `
    SELECT id, sequence, created_at
    FROM manifests
    WHERE workspace_id = ?
      AND project_id = ?
    ORDER BY sequence DESC
    LIMIT 1
    `
  )
    .bind(params.workspaceId, params.projectId)
    .first<{ id: string; sequence: number; created_at: string }>();

  if (!manifest) {
    return json({ manifest: null });
  }

  const files = await env.DB.prepare(
    `
    SELECT
      path,
      blob_sha256 AS sha256,
      size_bytes AS sizeBytes,
      mode,
      mtime_ms AS mtimeMs,
      file_type AS fileType,
      symlink_target AS symlinkTarget
    FROM manifest_files
    WHERE manifest_id = ?
    ORDER BY path ASC
    `
  )
    .bind(manifest.id)
    .all();

  return json({
    manifest: {
      id: manifest.id,
      sequence: manifest.sequence,
      createdAt: manifest.created_at,
      files: files.results
    }
  });
}
```

---

# Durable Object for Workspace Live Sync

This is optional for MVP, but the shape should be anticipated early.

```ts
// apps/api/src/workspace-sync-object.ts
export class WorkspaceSyncObject {
  private state: DurableObjectState;
  private sessions = new Set<WebSocket>();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sessions.add(server);

      server.addEventListener("close", () => {
        this.sessions.delete(server);
      });

      server.addEventListener("error", () => {
        this.sessions.delete(server);
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const event = await request.json();

      for (const session of this.sessions) {
        try {
          session.send(JSON.stringify(event));
        } catch {
          this.sessions.delete(session);
        }
      }

      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
```

Eventually the CLI can maintain a WebSocket:

```txt
Device A commits manifest.
Worker writes D1.
Worker broadcasts through WorkspaceSyncObject.
Device B receives event and pulls latest manifest.
```

---

# CLI Architecture

The CLI is responsible for:

```txt
local workspace init
project detection
ignore matching
file hashing
manifest creation
blob upload
manifest commit
manifest pull
download missing files
hydration
doctor checks
```

Suggested CLI commands:

```bash
codesync login
codesync device register
codesync workspace create
codesync project add
codesync scan
codesync status
codesync push
codesync pull
codesync hydrate
codesync doctor
```

---

# CLI Repo Structure

```txt
apps/cli/
  src/
    cli.ts
    commands/
      init.ts
      scan.ts
      status.ts
      hydrate.ts
      doctor.ts
      push.ts
      pull.ts
    core/
      workspace.ts
      project-detection.ts
      ignore-rules.ts
      host.ts
      hydrate.ts
      manifest.ts
    api/
      client.ts
    types.ts
```

---

# CLI package.json

```json
{
  "name": "codesync",
  "version": "0.0.1",
  "type": "module",
  "bin": {
    "codesync": "./dist/cli.js"
  },
  "scripts": {
    "dev": "bun run src/cli.ts",
    "build": "tsc",
    "start": "node dist/cli.js"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "fast-glob": "^3.3.2",
    "ignore": "^5.3.2",
    "yaml": "^2.5.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.4"
  }
}
```

---

# CLI Types

```ts
// apps/cli/src/types.ts
export type Platform = NodeJS.Platform;
export type Arch = NodeJS.Architecture;

export type WorkspaceConfig = {
  workspaceId: string;
  remoteWorkspaceId?: string;
  accountId?: string;
  rootPath: string;
  createdAt: string;
  projects: ProjectRecord[];
};

export type ProjectRecord = {
  id: string;
  remoteProjectId?: string;
  name: string;
  relativePath: string;
  detectedType: ProjectType;
  packageManager?: PackageManager;
  hydrateCommands: string[];
};

export type ProjectType =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "docker"
  | "unknown";

export type PackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "cargo"
  | "go";

export type HostFacts = {
  hostId: string;
  platform: Platform;
  arch: Arch;
  homeDir: string;
  nodeVersion?: string;
  npmVersion?: string;
  pnpmVersion?: string;
  yarnVersion?: string;
  bunVersion?: string;
  dockerAvailable: boolean;
};

export type CodeSyncProjectConfig = {
  name?: string;
  sync?: {
    include?: string[];
    exclude?: string[];
  };
  hydrate?: {
    commands?: string[];
  };
  doctor?: {
    required?: {
      node?: string;
      packageManager?: string;
      docker?: boolean;
    };
  };
  local?: {
    requiredFiles?: string[];
    preserve?: string[];
  };
};
```

---

# CLI Entrypoint

```ts
// apps/cli/src/cli.ts
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { scanCommand } from "./commands/scan.js";
import { statusCommand } from "./commands/status.js";
import { hydrateCommand } from "./commands/hydrate.js";
import { doctorCommand } from "./commands/doctor.js";

const program = new Command();

program
  .name("codesync")
  .description("Developer-aware project sync and hydration tool")
  .version("0.0.1");

program
  .command("init")
  .argument("[path]", "Workspace path", process.cwd())
  .description("Initialize a CodeSync workspace")
  .action(initCommand);

program
  .command("scan")
  .argument("[path]", "Workspace path", process.cwd())
  .description("Scan workspace for projects")
  .action(scanCommand);

program
  .command("status")
  .argument("[path]", "Workspace path", process.cwd())
  .description("Show CodeSync workspace status")
  .action(statusCommand);

program
  .command("hydrate")
  .argument("<project>", "Project name or path")
  .option("-w, --workspace <path>", "Workspace path", process.cwd())
  .option("-y, --yes", "Run without confirmation")
  .description("Install local dependencies for a project")
  .action(hydrateCommand);

program
  .command("doctor")
  .argument("[path]", "Workspace path", process.cwd())
  .description("Check host and project readiness")
  .action(doctorCommand);

await program.parseAsync();
```

---

# Workspace Init

```ts
// apps/cli/src/commands/init.ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceConfig } from "../types.js";

export async function initCommand(workspacePath: string) {
  const rootPath = path.resolve(workspacePath);
  const codesyncDir = path.join(rootPath, ".codesync");

  await fs.mkdir(codesyncDir, { recursive: true });

  const configPath = path.join(codesyncDir, "workspace.json");

  const config: WorkspaceConfig = {
    workspaceId: crypto.randomUUID(),
    rootPath,
    createdAt: new Date().toISOString(),
    projects: []
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  console.log(`Initialized CodeSync workspace at ${rootPath}`);
}
```

---

# Project Detection

```ts
// apps/cli/src/core/project-detection.ts
import path from "node:path";
import fs from "node:fs/promises";
import type { PackageManager, ProjectRecord, ProjectType } from "../types.js";

type DetectionResult = {
  type: ProjectType;
  packageManager?: PackageManager;
  hydrateCommands: string[];
};

export async function detectProject(projectPath: string): Promise<DetectionResult> {
  const files = new Set(await safeReaddir(projectPath));

  if (files.has("package.json")) {
    return detectNodeProject(files);
  }

  if (files.has("pyproject.toml")) {
    return {
      type: "python",
      packageManager: "poetry",
      hydrateCommands: ["poetry install"]
    };
  }

  if (files.has("requirements.txt")) {
    return {
      type: "python",
      packageManager: "pip",
      hydrateCommands: [
        "python -m venv .venv",
        sourceVenvCommand(),
        "pip install -r requirements.txt"
      ]
    };
  }

  if (files.has("Cargo.toml")) {
    return {
      type: "rust",
      packageManager: "cargo",
      hydrateCommands: ["cargo fetch"]
    };
  }

  if (files.has("go.mod")) {
    return {
      type: "go",
      packageManager: "go",
      hydrateCommands: ["go mod download"]
    };
  }

  if (files.has("docker-compose.yml") || files.has("compose.yml")) {
    return {
      type: "docker",
      hydrateCommands: ["docker compose pull"]
    };
  }

  return {
    type: "unknown",
    hydrateCommands: []
  };
}

function detectNodeProject(files: Set<string>): DetectionResult {
  if (files.has("pnpm-lock.yaml")) {
    return {
      type: "node",
      packageManager: "pnpm",
      hydrateCommands: ["pnpm install"]
    };
  }

  if (files.has("bun.lockb") || files.has("bun.lock")) {
    return {
      type: "node",
      packageManager: "bun",
      hydrateCommands: ["bun install"]
    };
  }

  if (files.has("yarn.lock")) {
    return {
      type: "node",
      packageManager: "yarn",
      hydrateCommands: ["yarn install --frozen-lockfile"]
    };
  }

  if (files.has("package-lock.json")) {
    return {
      type: "node",
      packageManager: "npm",
      hydrateCommands: ["npm ci"]
    };
  }

  return {
    type: "node",
    packageManager: "npm",
    hydrateCommands: ["npm install"]
  };
}

function sourceVenvCommand() {
  return process.platform === "win32"
    ? ".venv\\Scripts\\activate"
    : "source .venv/bin/activate";
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export function makeProjectRecord(args: {
  workspaceRoot: string;
  projectPath: string;
  detection: DetectionResult;
}): ProjectRecord {
  const relativePath = path.relative(args.workspaceRoot, args.projectPath);
  const name = path.basename(args.projectPath);

  return {
    id: relativePath.replaceAll(path.sep, "__"),
    name,
    relativePath,
    detectedType: args.detection.type,
    packageManager: args.detection.packageManager,
    hydrateCommands: args.detection.hydrateCommands
  };
}
```

---

# Scan Workspace

```ts
// apps/cli/src/commands/scan.ts
import path from "node:path";
import fg from "fast-glob";
import { detectProject, makeProjectRecord } from "../core/project-detection.js";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "../core/workspace.js";

const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "docker-compose.yml",
  "compose.yml"
];

export async function scanCommand(workspacePath: string) {
  const rootPath = path.resolve(workspacePath);
  const config = await loadWorkspaceConfig(rootPath);

  const markerMatches = await fg(PROJECT_MARKERS.map((m) => `**/${m}`), {
    cwd: rootPath,
    dot: true,
    ignore: [
      "**/.git/**",
      "**/.codesync/**",
      "**/node_modules/**",
      "**/.venv/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**"
    ]
  });

  const projectDirs = unique(
    markerMatches.map((match) => path.dirname(path.join(rootPath, match)))
  );

  const projects = [];

  for (const projectPath of projectDirs) {
    const detection = await detectProject(projectPath);
    projects.push(
      makeProjectRecord({
        workspaceRoot: rootPath,
        projectPath,
        detection
      })
    );
  }

  config.projects = projects;
  await saveWorkspaceConfig(rootPath, config);

  console.log(`Detected ${projects.length} project(s):`);

  for (const project of projects) {
    console.log(
      `- ${project.name} [${project.detectedType}${
        project.packageManager ? `/${project.packageManager}` : ""
      }]`
    );
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
```

---

# Workspace Config Helpers

```ts
// apps/cli/src/core/workspace.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceConfig } from "../types.js";

export async function loadWorkspaceConfig(rootPath: string): Promise<WorkspaceConfig> {
  const configPath = path.join(rootPath, ".codesync", "workspace.json");

  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    throw new Error(
      `No CodeSync workspace found at ${rootPath}. Run: codesync init ${rootPath}`
    );
  }
}

export async function saveWorkspaceConfig(
  rootPath: string,
  config: WorkspaceConfig
): Promise<void> {
  const configPath = path.join(rootPath, ".codesync", "workspace.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}
```

---

# Built-In Ignore Rules

CodeSync should combine ignore rules from multiple sources:

1. Built-in dev ignore rules
2. `.gitignore`
3. `.codesyncignore`
4. `.codesync.yml`

Built-in ignored folders:

```txt
node_modules/
.venv/
venv/
dist/
build/
.next/
.nuxt/
.svelte-kit/
.turbo/
.cache/
coverage/
target/
.DS_Store
.env
.env.*
*.sqlite
*.db
```

Important exception:

```txt
.env.example
```

should be syncable.

```ts
// apps/cli/src/core/ignore-rules.ts
import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

const BUILTIN_IGNORE_RULES = [
  ".git/",
  ".codesync/",
  "node_modules/",
  ".venv/",
  "venv/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".cache/",
  "coverage/",
  "target/",
  ".DS_Store",
  ".env",
  ".env.*",
  "*.sqlite",
  "*.sqlite3",
  "*.db",

  // But sync examples/templates.
  "!.env.example",
  "!.env.sample",
  "!.env.template"
];

export async function buildIgnoreMatcher(projectPath: string) {
  const ig = ignore();

  ig.add(BUILTIN_IGNORE_RULES);

  const gitignore = await readOptional(path.join(projectPath, ".gitignore"));
  if (gitignore) ig.add(gitignore);

  const codesyncIgnore = await readOptional(
    path.join(projectPath, ".codesyncignore")
  );
  if (codesyncIgnore) ig.add(codesyncIgnore);

  return {
    ignores(relativePath: string) {
      return ig.ignores(relativePath);
    }
  };
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}
```

---

# Project Manifest Generation

```ts
// apps/cli/src/core/manifest.ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { buildIgnoreMatcher } from "./ignore-rules.js";

export type ManifestFile = {
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
};

export type ProjectManifest = {
  projectPath: string;
  generatedAt: string;
  files: ManifestFile[];
};

export async function createProjectManifest(
  projectPath: string
): Promise<ProjectManifest> {
  const ignoreMatcher = await buildIgnoreMatcher(projectPath);

  const files = await fg("**/*", {
    cwd: projectPath,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false
  });

  const manifestFiles: ManifestFile[] = [];

  for (const relativePath of files) {
    if (ignoreMatcher.ignores(relativePath)) continue;

    const absolutePath = path.join(projectPath, relativePath);
    const stat = await fs.stat(absolutePath);
    const sha256 = await hashFile(absolutePath);

    manifestFiles.push({
      path: normalizePath(relativePath),
      sha256,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }

  return {
    projectPath,
    generatedAt: new Date().toISOString(),
    files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path))
  };
}

async function hashFile(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizePath(input: string) {
  return input.split(path.sep).join("/");
}
```

---

# Host Facts

```ts
// apps/cli/src/core/host.ts
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostFacts } from "../types.js";

const execFileAsync = promisify(execFile);

export async function getHostFacts(): Promise<HostFacts> {
  return {
    hostId: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    homeDir: os.homedir(),
    nodeVersion: process.version,
    npmVersion: await getCommandVersion("npm", ["--version"]),
    pnpmVersion: await getCommandVersion("pnpm", ["--version"]),
    yarnVersion: await getCommandVersion("yarn", ["--version"]),
    bunVersion: await getCommandVersion("bun", ["--version"]),
    dockerAvailable: Boolean(await getCommandVersion("docker", ["--version"]))
  };
}

async function getCommandVersion(
  command: string,
  args: string[]
): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, args);
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}
```

---

# Hydrate Command

For MVP, make this explicit and safe. Do not auto-run random commands from config without showing them or requiring approval unless the user passes `--yes`.

```ts
// apps/cli/src/commands/hydrate.ts
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execaCommand } from "../core/run.js";
import { loadWorkspaceConfig } from "../core/workspace.js";

type HydrateOptions = {
  workspace: string;
  yes?: boolean;
};

export async function hydrateCommand(projectNameOrPath: string, options: HydrateOptions) {
  const workspaceRoot = path.resolve(options.workspace);
  const config = await loadWorkspaceConfig(workspaceRoot);

  const project = config.projects.find(
    (p) =>
      p.name === projectNameOrPath ||
      p.relativePath === projectNameOrPath ||
      p.id === projectNameOrPath
  );

  if (!project) {
    throw new Error(`Project not found: ${projectNameOrPath}`);
  }

  if (project.hydrateCommands.length === 0) {
    console.log(`No hydrate commands detected for ${project.name}`);
    return;
  }

  const projectPath = path.join(workspaceRoot, project.relativePath);

  console.log(`Hydrating ${project.name}`);
  console.log(`Path: ${projectPath}`);
  console.log("");

  for (const command of project.hydrateCommands) {
    console.log(`$ ${command}`);
  }

  if (!options.yes) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question("\nRun these commands? [y/N] ");
    rl.close();

    if (answer.toLowerCase() !== "y") {
      console.log("Canceled.");
      return;
    }
  }

  for (const command of project.hydrateCommands) {
    await execaCommand(command, {
      cwd: projectPath
    });
  }

  console.log(`Hydrated ${project.name}`);
}
```

```ts
// apps/cli/src/core/run.ts
import { spawn } from "node:child_process";

export async function execaCommand(
  command: string,
  options: { cwd: string }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: "inherit"
    });

    child.on("error", reject);

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}: ${command}`));
    });
  });
}
```

---

# Status Command

```ts
// apps/cli/src/commands/status.ts
import path from "node:path";
import fs from "node:fs/promises";
import { loadWorkspaceConfig } from "../core/workspace.js";

export async function statusCommand(workspacePath: string) {
  const rootPath = path.resolve(workspacePath);
  const config = await loadWorkspaceConfig(rootPath);

  if (config.projects.length === 0) {
    console.log("No projects detected. Run: codesync scan");
    return;
  }

  for (const project of config.projects) {
    const projectPath = path.join(rootPath, project.relativePath);
    const missing = await getMissingLocalState(projectPath, project.detectedType);

    console.log("");
    console.log(`${project.name}`);
    console.log(`  Type: ${project.detectedType}`);
    if (project.packageManager) {
      console.log(`  Package manager: ${project.packageManager}`);
    }

    if (missing.length === 0) {
      console.log("  Status: runnable-ish");
    } else {
      console.log("  Status: needs hydration");
      for (const item of missing) {
        console.log(`  Missing: ${item}`);
      }
    }

    if (project.hydrateCommands.length > 0) {
      console.log(`  Hydrate: ${project.hydrateCommands.join(" && ")}`);
    }
  }
}

async function getMissingLocalState(
  projectPath: string,
  type: string
): Promise<string[]> {
  const missing: string[] = [];

  if (type === "node") {
    if (!(await exists(path.join(projectPath, "node_modules")))) {
      missing.push("node_modules");
    }
  }

  if (type === "python") {
    if (!(await exists(path.join(projectPath, ".venv")))) {
      missing.push(".venv");
    }
  }

  if (type === "rust") {
    if (!(await exists(path.join(projectPath, "target")))) {
      missing.push("target");
    }
  }

  return missing;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
```

---

# Doctor Command

```ts
// apps/cli/src/commands/doctor.ts
import path from "node:path";
import { getHostFacts } from "../core/host.js";
import { loadWorkspaceConfig } from "../core/workspace.js";

export async function doctorCommand(workspacePath: string) {
  const rootPath = path.resolve(workspacePath);
  const config = await loadWorkspaceConfig(rootPath);
  const host = await getHostFacts();

  console.log("Host");
  console.log(`  ID: ${host.hostId}`);
  console.log(`  Platform: ${host.platform}`);
  console.log(`  Arch: ${host.arch}`);
  console.log(`  Node: ${host.nodeVersion ?? "missing"}`);
  console.log(`  npm: ${host.npmVersion ?? "missing"}`);
  console.log(`  pnpm: ${host.pnpmVersion ?? "missing"}`);
  console.log(`  yarn: ${host.yarnVersion ?? "missing"}`);
  console.log(`  bun: ${host.bunVersion ?? "missing"}`);
  console.log(`  Docker: ${host.dockerAvailable ? "available" : "missing"}`);

  console.log("");
  console.log("Projects");

  for (const project of config.projects) {
    const issues: string[] = [];

    if (project.packageManager === "pnpm" && !host.pnpmVersion) {
      issues.push("pnpm required but not installed");
    }

    if (project.packageManager === "yarn" && !host.yarnVersion) {
      issues.push("yarn required but not installed");
    }

    if (project.packageManager === "bun" && !host.bunVersion) {
      issues.push("bun required but not installed");
    }

    if (project.packageManager === "npm" && !host.npmVersion) {
      issues.push("npm required but not installed");
    }

    console.log(`- ${project.name}`);

    if (issues.length === 0) {
      console.log("  ✓ OK");
    } else {
      for (const issue of issues) {
        console.log(`  ✗ ${issue}`);
      }
    }
  }
}
```

---

# Client API Wrapper

```ts
// apps/cli/src/api/client.ts
export class CodeSyncApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async uploadBlob(args: {
    accountId: string;
    sha256: string;
    sizeBytes: number;
    body: ArrayBuffer;
  }) {
    const response = await fetch(`${this.baseUrl}/v1/blobs`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.token}`,
        "x-codesync-account-id": args.accountId,
        "x-codesync-sha256": args.sha256,
        "x-codesync-size": String(args.sizeBytes)
      },
      body: args.body
    });

    if (!response.ok) {
      throw new Error(`Blob upload failed: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  async commitManifest(args: {
    workspaceId: string;
    projectId: string;
    deviceId: string;
    parentManifestId?: string;
    files: Array<{
      path: string;
      sha256?: string;
      sizeBytes: number;
      mtimeMs?: number;
      fileType: "file" | "symlink" | "deleted";
      symlinkTarget?: string;
    }>;
  }) {
    const response = await fetch(
      `${this.baseUrl}/v1/workspaces/${args.workspaceId}/projects/${args.projectId}/manifests`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          deviceId: args.deviceId,
          parentManifestId: args.parentManifestId ?? null,
          files: args.files
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Manifest commit failed: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }
}
```

---

# Client-Side Sync Algorithm

The client does this:

```txt
1. Scan project files.
2. Apply .gitignore + .codesyncignore + built-in ignores.
3. Hash syncable files.
4. Ask server which blob hashes are missing.
5. Upload missing blobs.
6. Commit manifest.
7. Pull latest remote manifest.
8. Download missing files locally.
9. Never download ignored machine-local files.
10. Run hydrate/doctor if needed.
```

Important:

> Manifest commit is separate from blob upload.

This avoids half-committed sync states.

---

# `.codesync.yml` Example

```yaml
name: project-a

sync:
  include:
    - "**/*"
  exclude:
    - "node_modules/**"
    - ".next/**"
    - "dist/**"
    - ".env"

hydrate:
  commands:
    - "pnpm install"

doctor:
  required:
    node: ">=22"
    packageManager: "pnpm"
    docker: true

local:
  requiredFiles:
    - ".env.local"
  preserve:
    - ".env"
    - ".env.local"
```

---

# `.codesyncignore` Example

```gitignore
# Dependencies
node_modules/
.venv/
vendor/bundle/

# Build outputs
dist/
build/
.next/
target/
coverage/

# Local env
.env
.env.*
!.env.example

# Local DBs
*.sqlite
*.sqlite3
*.db

# Editor / OS junk
.DS_Store
.idea/
.vscode/settings.json
```

---

# Symlink Strategy

It is technically possible to symlink dependency folders outside the project:

```bash
mkdir -p ~/.codesync/local/project-a/node_modules
ln -s ~/.codesync/local/project-a/node_modules ~/code/project-a/node_modules
```

But this should not be the core abstraction.

Problems:

1. Symlinks behave differently across macOS, Linux, Windows, WSL, Docker volumes, and network filesystems.
2. Some tools care about real paths.
3. Native dependencies are not portable across OS/architecture/runtime versions.

Recommended stance:

> Support symlinking later as an advanced local-state strategy, but start with ignore + hydrate.

Possible future config:

```yaml
localState:
  strategy: symlink
  root: "~/.codesync/local-state"
```

---

# Conflict Strategy

For MVP, use a simple parent-manifest check.

Client sends:

```json
{
  "parentManifestId": "man_123"
}
```

Server compares it to latest.

If latest changed since the client pulled:

```json
{
  "error": "manifest_conflict",
  "latestManifestId": "man_456"
}
```

Then client does one of:

```txt
pull latest
rebase local changes
create conflict copy
ask user
```

MVP behavior:

```txt
If same file changed on two devices:
  create "filename.codesync-conflict.<device>.<timestamp>.ext"
```

Do not be too clever early. Sync conflict engines are where optimism goes to die.

---

# Security Rules

These are non-negotiable.

## 1. All Rows Include `account_id`

Do this even when technically derivable from workspace/project.

It makes authorization and cleanup safer.

## 2. Never Trust Client Paths

Reject:

```txt
/absolute/path
../parent
foo/../../bar
null bytes
```

Normalize to POSIX-style paths:

```txt
src/index.ts
```

## 3. R2 Keys Must Not Contain User Paths

Bad:

```txt
accounts/acc_123/workspaces/ws_123/Users/brian/code/project-a/.env
```

Good:

```txt
blobs/sha256/ab/abcdef...
```

## 4. Secrets Excluded by Default

Never sync:

```txt
.env
.env.*
*.pem
*.key
id_rsa
id_ed25519
```

Allow explicit opt-in later, but do not start there.

## 5. File Size Limits

Set hard limits early:

```txt
Free plan:
  max blob size: 50 MB
  max workspace: 2 GB
  max files per manifest: 100k

Pro:
  max blob size: 500 MB
```

## 6. Audit Log

Record:

```txt
workspace created
device registered
manifest committed
member invited
member removed
blob deleted
```

---

# MVP Phases

## Phase 1: Cloud Control Plane

Build:

```txt
auth mapping
accounts
workspaces
devices
projects
blob upload
manifest commit
latest manifest pull
```

No live sync yet.

## Phase 2: CLI Push/Pull

Build:

```txt
codesync login
codesync device register
codesync workspace create
codesync project add
codesync push
codesync pull
codesync status
```

## Phase 3: Hydration Brain

Build:

```txt
project detection
dependency detection
ignored generated state
hydrate commands
doctor
```

## Phase 4: Live Sync

Add:

```txt
Durable Object per workspace
WebSocket from CLI
manifest event broadcast
auto-pull
```

## Phase 5: Teams

Add:

```txt
workspace invites
roles
audit log
billing/quota
```

---

# What to Ask Claude Code/Codex to Build First

```txt
Build a Cloudflare Workers API for CodeSync.

Use:
- Hono or a small hand-rolled router
- D1 for metadata
- R2 for content-addressed blobs
- Zod for validation
- Multi-user account/workspace/device model
- Bearer token auth stub initially

Implement:
1. D1 migrations for users, accounts, memberships, devices, workspaces, projects, manifests, manifest_files, blobs, blob_refs.
2. POST /v1/workspaces
3. POST /v1/devices/register
4. PUT /v1/blobs
5. POST /v1/workspaces/:workspaceId/projects/:projectId/manifests
6. GET /v1/workspaces/:workspaceId/projects/:projectId/latest

All routes must:
- authenticate user
- validate input
- enforce account/workspace membership
- reject unsafe paths
- never use user paths as R2 object keys
```

---

# Strong Recommendation

Make CodeSync a **manifest-sync product first**, not a magic filesystem product.

Magic filesystem products become haunted houses.

Manifest sync gives CodeSync:

```txt
clean protocol
security boundaries
team support
resumability
a path to live sync later
```

The first magical demo should be:

```bash
codesync scan
codesync doctor
codesync hydrate --all
codesync push
```

With output like:

```txt
Detected 3 projects:

project-a
  Node / pnpm
  Source syncable
  Missing node_modules
  Hydrate: pnpm install

project-b
  Python / pip
  Source syncable
  Missing .venv
  Hydrate: python -m venv .venv && pip install -r requirements.txt

project-c
  Rust / cargo
  Source syncable
  Missing target
  Hydrate: cargo fetch

Host is ready for 2/3 projects.
Missing: pnpm
```

That is the wedge.

Sync is boring. Making a dev environment portable without syncing garbage is the product.
