import { env, SELF, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BASE = "https://example.com";

// Apply D1 migrations against the local test DB once.
beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

// Each test bootstraps its own account/device so they're isolated.
async function bootstrap(accountName: string): Promise<{ token: string; accountId: string; deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; accountId: string; deviceId: string };
}

const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

describe("worker integration (real DO + D1 + R2)", () => {
  test("health is public", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  test("unauthenticated request → 401", async () => {
    const res = await SELF.fetch(`${BASE}/v1/account/usage`);
    expect(res.status).toBe(401);
  });

  test("blob entitlement: PUT grants, GET works; a different account 404s the same sha", async () => {
    const a = await bootstrap("acct-blob-a");
    const content = "blob-entitlement-content";
    const s = sha(content);
    const put = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(a.token, { "content-length": String(content.length) }), body: content });
    expect(put.status).toBe(200);
    const get = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { headers: authed(a.token) });
    expect(get.status).toBe(200);
    // A second account never uploaded it → not entitled → 404 (cross-account isolation).
    const b = await bootstrap("acct-blob-b");
    const cross = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { headers: authed(b.token) });
    expect(cross.status).toBe(404);
  });

  // The DO commit sequencer uses `ctx.storage.kv` + `transactionSync` — DO storage
  // APIs newer than the workerd bundled with the pinned vitest-pool-workers (which
  // caps at compat 2025-07-30). These paths are verified LIVE (M1–M7) and the
  // client-side 409/422/retry logic is automated in src/cli/sync.test.ts against a
  // stateful FakeRemote. Re-enable when a pool-workers/runtime with storage.kv lands.
  // Build the new E2EE commit envelope. The server stores it opaquely and does NOT
  // verify the signature/canonicalization, so commitHash/sig can be any well-formed
  // dummies — only encManifestSha + blobRefs.encSha must reference uploaded blobs.
  const signedCommit = (over: {
    accountId: string;
    workspaceId: string;
    deviceId: string;
    seq?: number;
    parentSeq?: number;
    accountEpoch?: number;
    encManifestSha: string;
    blobRefs?: Array<{ encSha: string; size: number }>;
  }) => {
    const seq = over.seq ?? 1;
    const parentSeq = over.parentSeq ?? 0;
    const body = JSON.stringify({
      type: "rbox/commit/v1",
      accountId: over.accountId,
      accountEpoch: over.accountEpoch ?? 0,
      workspaceId: over.workspaceId,
      seq,
      parentSeq,
      parentCommitHash: "0".repeat(64),
      rosterVersion: 0,
      keyEpoch: 0,
      deviceId: over.deviceId,
      encManifestSha: over.encManifestSha,
      blobRefs: over.blobRefs ?? [],
    });
    return { commit: { body, commitHash: "a".repeat(64), sig: "dummy-sig" } };
  };

  test.skip("commit sequencer: clean commit, then a STALE parent → 409 conflict", async () => {
    const a = await bootstrap("acct-commit");
    // Create a workspace (server-owned).
    const wsRes = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(wsRes.status).toBe(200);
    const ws = ((await wsRes.json()) as { workspaceId: string }).workspaceId;

    // Upload the encrypted-manifest blob + a referenced content blob, then commit.
    const manifestSha = sha("enc-manifest");
    const contentSha = sha("commit-payload");
    for (const [c, s] of [["enc-manifest", manifestSha], ["commit-payload", contentSha]] as const) {
      await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(a.token, { "content-length": String(c.length) }), body: c });
    }
    const commitUrl = `${BASE}/v1/ws/${ws}/proj/root/manifests`;
    const env1 = signedCommit({ accountId: a.accountId, workspaceId: ws, deviceId: a.deviceId, encManifestSha: manifestSha, blobRefs: [{ encSha: contentSha, size: 14 }] });
    const c1 = await SELF.fetch(commitUrl, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, ...env1 }) });
    expect(c1.status).toBe(200);
    expect(((await c1.json()) as { sequence: number }).sequence).toBe(1);

    // Re-commit with the now-stale parent 0 → 409.
    const c2 = await SELF.fetch(commitUrl, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, ...env1 }) });
    expect(c2.status).toBe(409);
  });

  test.skip("commit referencing an un-uploaded blob → 422 unsatisfied (entitlement-scoped)", async () => {
    const a = await bootstrap("acct-422");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const ghostSha = sha("never-uploaded");
    const envc = signedCommit({ accountId: a.accountId, workspaceId: ws, deviceId: a.deviceId, encManifestSha: ghostSha });
    const res = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/manifests`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, ...envc }) });
    expect(res.status).toBe(422);
  });

  // C1: commits?since returns the stored chain for (since, head]. Exercises DO
  // storage.kv (unavailable in this runtime — see note above), so it's SKIPPED;
  // verified live. We still pin the contract: each returned entry is a full
  // SignedCommit and they're in ascending sequence from since+1.
  test.skip("commits?since returns the SignedCommit chain from the pinned seq to head", async () => {
    const a = await bootstrap("acct-commits-since");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const commitUrl = `${BASE}/v1/ws/${ws}/proj/root/manifests`;
    // Land two commits (seq 1, 2).
    for (let seq = 1; seq <= 2; seq++) {
      const m = sha(`enc-manifest-${seq}`);
      await SELF.fetch(`${BASE}/v1/blobs/${m}`, { method: "PUT", headers: authed(a.token, { "content-length": String(`enc-manifest-${seq}`.length) }), body: `enc-manifest-${seq}` });
      const env1 = signedCommit({ accountId: a.accountId, workspaceId: ws, deviceId: a.deviceId, seq, parentSeq: seq - 1, encManifestSha: m });
      const c = await SELF.fetch(commitUrl, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: seq - 1, ...env1 }) });
      expect(c.status).toBe(200);
    }
    // since=0 → both commits; since=1 → only seq 2.
    const all = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/commits?since=0`, { headers: authed(a.token) });
    expect(all.status).toBe(200);
    expect(((await all.json()) as { commits: unknown[] }).commits).toHaveLength(2);
    const tail = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/commits?since=1`, { headers: authed(a.token) });
    expect(((await tail.json()) as { commits: Array<{ body: string }> }).commits).toHaveLength(1);
  });

  // C4: a commit signed under a stale/unknown epoch is refused inside the DO's
  // head-advance txn. SKIPPED (DO storage.kv unavailable here); the authoritative
  // guarantee is the client-side roster/epoch check, this is the server backstop.
  test.skip("commit with accountEpoch != current → 409 epoch_stale", async () => {
    const a = await bootstrap("acct-epoch-stale");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    // Account is at epoch 0 (no key-states); a commit claiming epoch 1 is stale.
    const m = sha("enc-manifest-epoch");
    await SELF.fetch(`${BASE}/v1/blobs/${m}`, { method: "PUT", headers: authed(a.token, { "content-length": "17" }), body: "enc-manifest-epoc" });
    const envc = signedCommit({ accountId: a.accountId, workspaceId: ws, deviceId: a.deviceId, accountEpoch: 1, encManifestSha: m });
    const res = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/manifests`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, ...envc }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("epoch_stale");
  });

  test("free plan workspace cap: 2nd workspace → 402 quota_exceeded", async () => {
    const a = await bootstrap("acct-quota");
    const first = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(second.status).toBe(402);
  });

  // ── pairing tokens (M10) ─────────────────────────────────────────────────

  const pairCreate = (token: string) => SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: authed(token) });
  const pairRedeem = (pair: string) =>
    SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair, label: "new-machine" }) });

  test("pair/create requires auth (no token → 401)", async () => {
    const res = await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("pair create → redeem mints a working device on the SAME account", async () => {
    const a = await bootstrap("acct-pair");
    const cr = await pairCreate(a.token);
    expect(cr.status).toBe(200);
    const { token: pair } = (await cr.json()) as { token: string };
    expect(pair.startsWith("rbox-pair_")).toBe(true);

    const rd = await pairRedeem(pair);
    expect(rd.status).toBe(200);
    const { token: deviceToken, deviceId } = (await rd.json()) as { token: string; deviceId: string };
    expect(deviceId.startsWith("dev_")).toBe(true);
    // The minted token authenticates and lands in the creator's account.
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(deviceToken) });
    expect(usage.status).toBe(200);
    expect(((await usage.json()) as { plan: string }).plan).toBe("free");
  });

  test("pairing token is SINGLE-USE (second redeem → 401)", async () => {
    const a = await bootstrap("acct-pair-once");
    const { token: pair } = (await (await pairCreate(a.token)).json()) as { token: string };
    expect((await pairRedeem(pair)).status).toBe(200);
    expect((await pairRedeem(pair)).status).toBe(401); // already consumed
  });

  test("malformed / unknown pairing token → 401", async () => {
    expect((await pairRedeem("rbox-pair_not-hex")).status).toBe(401);
    expect((await pairRedeem(`rbox-pair_${"a".repeat(64)}`)).status).toBe(401); // well-formed but unknown
  });

  test("expired pairing token → 401 (and is not minted)", async () => {
    const a = await bootstrap("acct-pair-exp");
    // Insert a token that's already expired, directly into D1.
    const { createHash } = await import("node:crypto");
    const raw = "b".repeat(64);
    const hash = createHash("sha256").update(raw).digest("hex");
    const past = Date.now() - 1000;
    await env.rbox_dev_db
      .prepare("INSERT INTO pairing_tokens (token_hash, account_id, user_id, created_by, label, created_at, expires_at) VALUES (?, ?, ?, ?, 'x', ?, ?)")
      .bind(hash, a.accountId, "u", a.deviceId, past - 1000, past)
      .run();
    expect((await pairRedeem(`rbox-pair_${raw}`)).status).toBe(401);
  });

  test("revoked creator device → its outstanding token is dead at redeem (fix #1)", async () => {
    const a = await bootstrap("acct-pair-revoke");
    const { token: pair } = (await (await pairCreate(a.token)).json()) as { token: string };
    // Revoke the device that created the token, THEN try to redeem it.
    await env.rbox_dev_db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?").bind(a.deviceId).run();
    expect((await pairRedeem(pair)).status).toBe(401); // live-authority check fails closed
  });

  test("active-token cap enforced (6th create → 429)", async () => {
    const a = await bootstrap("acct-pair-cap");
    for (let i = 0; i < 5; i++) expect((await pairCreate(a.token)).status).toBe(200);
    expect((await pairCreate(a.token)).status).toBe(429);
  });

  // ── Stripe billing (M10) ─────────────────────────────────────────────────

  test("billing/checkout + portal are gated on STRIPE_SECRET (absent → 501)", async () => {
    const a = await bootstrap("acct-bill");
    expect((await SELF.fetch(`${BASE}/v1/billing/checkout?plan=pro`, { method: "POST", headers: authed(a.token) })).status).toBe(501);
    expect((await SELF.fetch(`${BASE}/v1/billing/portal`, { method: "POST", headers: authed(a.token) })).status).toBe(501);
  });

  // Sign a payload exactly as Stripe does: HMAC-SHA256 over `${t}.${body}`.
  async function stripeSig(body: string, secret: string, t: number): Promise<string> {
    const { createHmac } = await import("node:crypto");
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return `t=${t},v1=${v1}`;
  }
  const webhook = (body: string, sig: string) =>
    SELF.fetch(`${BASE}/v1/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body });

  test("webhook rejects a bad/forged signature → 400 (no plan change)", async () => {
    const evt = JSON.stringify({ id: "evt_bad", type: "customer.subscription.updated", data: { object: {} } });
    expect((await webhook(evt, "t=123,v1=deadbeef")).status).toBe(400);
  });

  test("webhook flips accounts.plan on an active subscription (valid signature)", async () => {
    const a = await bootstrap("acct-sub");
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_sub_1",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "active", customer: "cus_sub1", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: "rbox_pro_monthly" } }] } } },
    });
    const res = await webhook(body, await stripeSig(body, "whsec_test_secret", t));
    expect(res.status).toBe(200);
    // Confirm via the authed usage endpoint that the plan is now pro.
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) });
    expect(((await usage.json()) as { plan: string }).plan).toBe("pro");
  });

  test("webhook is idempotent (same event id re-delivered → duplicate, applied once)", async () => {
    const a = await bootstrap("acct-idem");
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_dup",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_2", status: "active", customer: "cus_sub2", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: "rbox_solo_monthly" } }] } } },
    });
    const sig = await stripeSig(body, "whsec_test_secret", t);
    expect((await (await webhook(body, sig)).json() as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect((await (await webhook(body, sig)).json() as { duplicate?: boolean }).duplicate).toBe(true); // 2nd = no-op
  });

  test("webhook downgrades to free when subscription is canceled/past_due", async () => {
    const a = await bootstrap("acct-cancel");
    const t = Math.floor(Date.now() / 1000);
    const mk = (id: string, status: string, lk: string) =>
      JSON.stringify({ id, type: "customer.subscription.updated", data: { object: { id: "sub_3", status, customer: "cus_sub3", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: lk } }] } } } });
    const up = mk("evt_up", "active", "rbox_pro_monthly");
    await webhook(up, await stripeSig(up, "whsec_test_secret", t));
    const down = mk("evt_down", "past_due", "rbox_pro_monthly");
    await webhook(down, await stripeSig(down, "whsec_test_secret", t));
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) });
    expect(((await usage.json()) as { plan: string }).plan).toBe("free"); // fail-closed
  });

  // ── web auth via Clerk (M11) ─────────────────────────────────────────────

  // Generate a test RSA key, publish it as the JWKS, and sign Clerk-like JWTs.
  const b64url = (buf: ArrayBuffer | Uint8Array) => {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = ""; for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  let priv: CryptoKey;
  const KID = "test-kid-1";
  const ISS = "https://clerk.test";
  const AZP = "https://app.test";

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    priv = pair.privateKey;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string; use?: string; alg?: string };
    jwk.kid = KID; jwk.use = "sig"; jwk.alg = "RS256";
    const { fetchMock } = await import("cloudflare:test");
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://clerk.test").intercept({ path: "/.well-known/jwks.json" }).reply(200, JSON.stringify({ keys: [jwk] })).persist();
    // Clerk Backend API (email verification): every sub verified EXCEPT "user_unverified".
    fetchMock
      .get("https://api.clerk.com")
      .intercept({ path: /^\/v1\/users\//, method: "GET" })
      .reply((opts: { path: string }) => {
        const sub = decodeURIComponent(opts.path.split("/").pop() ?? "");
        const status = sub === "user_unverified" ? "unverified" : "verified";
        return { statusCode: 200, data: JSON.stringify({ primary_email_address_id: "e1", email_addresses: [{ id: "e1", verification: { status } }] }) };
      })
      .persist();
  });

  async function signJwt(payload: Record<string, unknown>, opts: { alg?: string; kid?: string } = {}): Promise<string> {
    const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" };
    const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
    const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    if (header.alg === "none") return `${h}.${p}.`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (over: Record<string, unknown> = {}) => ({ iss: ISS, sub: "user_clerk_1", azp: AZP, exp: now() + 60, nbf: now() - 5, ...over });
  const webExchange = (token: string) =>
    SELF.fetch(`${BASE}/v1/web/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });

  test("valid Clerk JWT → rbox web session token that authenticates", async () => {
    const res = await webExchange(await signJwt(claims()));
    expect(res.status).toBe(200);
    const { token, accountId } = (await res.json()) as { token: string; accountId: string };
    expect(accountId.startsWith("acct_")).toBe(true);
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(token) });
    expect(usage.status).toBe(200);
  });

  test("same Clerk user logging in twice reuses the SAME account (idempotent)", async () => {
    const a1 = (await (await webExchange(await signJwt(claims({ sub: "user_dup" })))).json()) as { accountId: string };
    const a2 = (await (await webExchange(await signJwt(claims({ sub: "user_dup" })))).json()) as { accountId: string };
    expect(a1.accountId).toBe(a2.accountId);
  });

  test("forged signature → 401", async () => {
    const t = await signJwt(claims({ sub: "user_forge" }));
    const tampered = t.slice(0, -4) + (t.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect((await webExchange(tampered)).status).toBe(401);
  });

  test("alg:none → 401 (algorithm-confusion guard)", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_none" }), { alg: "none" }))).status).toBe(401);
  });

  test("wrong issuer → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_iss", iss: "https://evil.test" })))).status).toBe(401);
  });

  test("expired token → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_exp", exp: now() - 120 })))).status).toBe(401);
  });

  test("disallowed azp (origin) → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_azp", azp: "https://evil.test" })))).status).toBe(401);
  });

  test("absent azp → 401 (web route requires origin binding)", async () => {
    const c = claims({ sub: "u_noazp" }); delete (c as Record<string, unknown>).azp;
    expect((await webExchange(await signJwt(c))).status).toBe(401);
  });

  test("unknown kid → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_kid" }), { kid: "nope" }))).status).toBe(401);
  });

  test("JWT whose header/payload decode to non-objects → 401 (not 500)", async () => {
    const nullHeader = `${b64url(new TextEncoder().encode("null"))}.${b64url(new TextEncoder().encode(JSON.stringify(claims())))}.AAAA`;
    expect((await webExchange(nullHeader)).status).toBe(401);
  });

  test("first-login with an UNVERIFIED email → 403 (abuse gate), no account created", async () => {
    const res = await webExchange(await signJwt(claims({ sub: "user_unverified" })));
    expect(res.status).toBe(403);
    // A subsequent call still 403s (no mapping was claimed → gate re-runs).
    expect((await webExchange(await signJwt(claims({ sub: "user_unverified" })))).status).toBe(403);
  });

  // ── E2EE opaque key storage (design 12) ──────────────────────────────────

  const keysBootstrap = (token: string, deviceId: string, over: Record<string, unknown> = {}) =>
    SELF.fetch(`${BASE}/v1/keys/bootstrap`, {
      method: "POST",
      headers: authed(token, { "content-type": "application/json" }),
      body: JSON.stringify({
        recoveryWrap: "rw",
        recoveryWrapId: "rwid",
        genesisRoster: "roster-v0",
        genesisKeyState: "keystate-0",
        device: { deviceId, sigPubKey: "sig", encPubKey: "enc", mkWrap: "mk" },
        ...over,
      }),
    });

  test("keys bootstrap → account read returns genesis material; second bootstrap → 409", async () => {
    const a = await bootstrap("acct-keys");
    expect((await keysBootstrap(a.token, a.deviceId)).status).toBe(200);

    const acct = await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) });
    expect(acct.status).toBe(200);
    const body = (await acct.json()) as { recoveryWrap: string; rosters: string[]; keyStates: string[]; devices: Array<{ deviceId: string }> };
    expect(body.recoveryWrap).toBe("rw");
    expect(body.rosters).toEqual(["roster-v0"]);
    expect(body.keyStates).toEqual(["keystate-0"]);
    expect(body.devices.map((d) => d.deviceId)).toContain(a.deviceId);

    expect((await keysBootstrap(a.token, a.deviceId)).status).toBe(409); // already bootstrapped
  });

  test("keys bootstrap with a device that isn't the caller's → 403", async () => {
    const a = await bootstrap("acct-keys-spoof");
    expect((await keysBootstrap(a.token, "dev_someone_else")).status).toBe(403);
  });

  test("account keys not found before bootstrap → 404", async () => {
    const a = await bootstrap("acct-keys-empty");
    expect((await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) })).status).toBe(404);
  });

  test("roster append is monotone: next version OK, replay/skew → 409", async () => {
    const a = await bootstrap("acct-roster");
    await keysBootstrap(a.token, a.deviceId); // genesis roster = v0
    const append = (version: number) =>
      SELF.fetch(`${BASE}/v1/keys/roster`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ version, signed: `roster-v${version}` }) });
    expect((await append(1)).status).toBe(200); // exactly next
    expect((await append(1)).status).toBe(409); // replay (already at 1)
    expect((await append(5)).status).toBe(409); // skips ahead
    expect((await append(2)).status).toBe(200); // next again
    const acct = (await (await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) })).json()) as { rosters: string[] };
    expect(acct.rosters).toEqual(["roster-v0", "roster-v1", "roster-v2"]);
  });

  test("keystate append is monotone by epoch (next OK, replay → 409)", async () => {
    const a = await bootstrap("acct-keystate");
    await keysBootstrap(a.token, a.deviceId); // genesis keystate = epoch 0
    const append = (accountEpoch: number) =>
      SELF.fetch(`${BASE}/v1/keys/keystate`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ accountEpoch, signed: `ks-${accountEpoch}` }) });
    expect((await append(1)).status).toBe(200);
    expect((await append(1)).status).toBe(409);
  });

  test("workspace keys: put + get round-trips; cross-account get → 404", async () => {
    const a = await bootstrap("acct-wskey");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const put = await SELF.fetch(`${BASE}/v1/keys/workspace`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ workspaceId: ws, keyEpoch: 0, kekWrap: "kek-0" }) });
    expect(put.status).toBe(200);
    const got = await SELF.fetch(`${BASE}/v1/keys/workspace/${ws}`, { headers: authed(a.token) });
    expect(got.status).toBe(200);
    expect((await got.json()) as { keys: unknown[] }).toEqual({ keys: [{ keyEpoch: 0, kekWrap: "kek-0" }] });

    // A different account must not see (or even confirm) the workspace's keys.
    const b = await bootstrap("acct-wskey-other");
    expect((await SELF.fetch(`${BASE}/v1/keys/workspace/${ws}`, { headers: authed(b.token) })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/keys/workspace`, { method: "POST", headers: authed(b.token, { "content-type": "application/json" }), body: JSON.stringify({ workspaceId: ws, keyEpoch: 0, kekWrap: "evil" }) })).status).toBe(404);
  });

  // C3: putWorkspaceKey is an immutable CAS — the FIRST wrap wins and a later
  // caller with a DIFFERENT wrap gets the first one back (adopts it, never an UPDATE).
  test("workspace key CAS: second writer with a different wrap gets the FIRST wrap back", async () => {
    const a = await bootstrap("acct-wskey-cas");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const put = (kekWrap: string) =>
      SELF.fetch(`${BASE}/v1/keys/workspace`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ workspaceId: ws, keyEpoch: 0, kekWrap }) });
    const first = (await (await put("kek-first")).json()) as { keyEpoch: number; kekWrap: string };
    expect(first).toEqual({ keyEpoch: 0, kekWrap: "kek-first" });
    // A second, different wrap for the SAME epoch must NOT overwrite — the winning
    // (first) wrap is returned so the loser converges on it.
    const second = (await (await put("kek-second")).json()) as { keyEpoch: number; kekWrap: string };
    expect(second).toEqual({ keyEpoch: 0, kekWrap: "kek-first" });
    // And the stored value is still the first wrap.
    const got = (await (await SELF.fetch(`${BASE}/v1/keys/workspace/${ws}`, { headers: authed(a.token) })).json()) as { keys: Array<{ keyEpoch: number; kekWrap: string }> };
    expect(got.keys).toEqual([{ keyEpoch: 0, kekWrap: "kek-first" }]);
  });

  // C5: /keys/admit inserts device keys AND appends the roster in one D1 batch.
  const admit = (token: string, deviceId: string, version: number, signed: string) =>
    SELF.fetch(`${BASE}/v1/keys/admit`, {
      method: "POST",
      headers: authed(token, { "content-type": "application/json" }),
      body: JSON.stringify({ device: { deviceId, sigPubKey: "sig", encPubKey: "enc", mkWrap: "mk" }, roster: { version, signed } }),
    });

  test("keys/admit: atomic device-keys + roster append (happy path) lands both", async () => {
    const a = await bootstrap("acct-admit");
    await keysBootstrap(a.token, a.deviceId); // genesis roster = v0
    const res = await admit(a.token, "dev_admitted_1", 1, "roster-v1");
    expect(res.status).toBe(200);
    const acct = (await (await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) })).json()) as { rosters: string[]; devices: Array<{ deviceId: string }> };
    expect(acct.rosters).toEqual(["roster-v0", "roster-v1"]); // roster appended
    expect(acct.devices.map((d) => d.deviceId)).toContain("dev_admitted_1"); // device stored
  });

  test("keys/admit: wrong roster version → 409 AND leaves NO device_keys row (atomic rollback)", async () => {
    const a = await bootstrap("acct-admit-conflict");
    await keysBootstrap(a.token, a.deviceId); // roster at v0, so next is v1
    // Claim v5 (skips ahead) → roster guard fails → batch applies nothing.
    const res = await admit(a.token, "dev_orphan", 5, "roster-v5");
    expect(res.status).toBe(409);
    // The device must NOT have been written (no orphan referencing an un-rostered wrap).
    const row = await env.rbox_dev_db.prepare("SELECT 1 FROM device_keys WHERE device_id = ?").bind("dev_orphan").first();
    expect(row).toBeNull();
    const acct = (await (await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) })).json()) as { rosters: string[] };
    expect(acct.rosters).toEqual(["roster-v0"]); // roster unchanged
  });

  // C6: the client owns the tokenId (so the grant binds the exact token); the
  // server stores keyed by it and redeem looks it up.
  test("pair/create with a client tokenId redeems by that same tokenId", async () => {
    const a = await bootstrap("acct-pair-tokenid");
    const tokenId = "clientchosen_tokenid_0001"; // 16–64 url-safe chars
    const cr = await SELF.fetch(`${BASE}/v1/auth/pair/create`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ tokenId, mkWrap: "mk-blob", admissionGrant: "grant-blob" }),
    });
    expect(cr.status).toBe(200);
    const { token } = (await cr.json()) as { token: string };
    expect(token).toBe(`rbox-pair_${tokenId}`); // server adopted the client id verbatim
    // Redeem by the client tokenId → mints a working device + returns the bound material.
    const rd = await SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    expect(rd.status).toBe(200);
    const redeemed = (await rd.json()) as { token: string; deviceId: string; mkWrap: string | null; admissionGrant: string | null };
    expect(redeemed.deviceId.startsWith("dev_")).toBe(true);
    expect(redeemed.mkWrap).toBe("mk-blob");
    expect(redeemed.admissionGrant).toBe("grant-blob");
    // Single-use still holds for the client-supplied id.
    expect((await SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).status).toBe(401);
  });

  test("pair/create rejects a malformed client tokenId → 400", async () => {
    const a = await bootstrap("acct-pair-badid");
    const res = await SELF.fetch(`${BASE}/v1/auth/pair/create`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ tokenId: "too-short" }), // < 16 chars
    });
    expect(res.status).toBe(400);
  });

  test("pairing token carries opaque E2EE material through create → redeem", async () => {
    const a = await bootstrap("acct-pair-e2ee");
    const cr = await SELF.fetch(`${BASE}/v1/auth/pair/create`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ mkWrap: "mk-wrap-blob", admissionGrant: "grant-blob" }),
    });
    expect(cr.status).toBe(200);
    const { token: pair } = (await cr.json()) as { token: string };
    const rd = await SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair }) });
    expect(rd.status).toBe(200);
    const redeemed = (await rd.json()) as { mkWrap: string | null; admissionGrant: string | null };
    expect(redeemed.mkWrap).toBe("mk-wrap-blob");
    expect(redeemed.admissionGrant).toBe("grant-blob");
  });

  const PLAT = { "x-rbox-platform": "test-platform-secret" };

  test("retention prune is platform-gated (tenant token → 404)", async () => {
    const a = await bootstrap("acct-ret-gate");
    const res = await SELF.fetch(`${BASE}/v1/admin/gc?phase=retention`, { method: "POST", headers: authed(a.token) });
    expect(res.status).toBe(404);
  });

  test("retention prune runs the plan→floor pass over workspaces (no old versions → 0 pruned)", async () => {
    // Exercises the workspaces⋈accounts join + per-plan cutoff query. The DO
    // prune reclaim itself uses ctx.storage.kv (skipped here; verified live, M6) —
    // with no committed versions there's nothing past the window, so no DO call.
    const a = await bootstrap("acct-ret");
    await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    const res = await SELF.fetch(`${BASE}/v1/admin/gc?phase=retention`, { method: "POST", headers: PLAT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: number; pruned: number };
    expect(body.ok).toBe(true);
    expect(body.workspaces).toBeGreaterThanOrEqual(1); // our workspace was in the pass
    expect(body.pruned).toBe(0); // nothing old enough to prune
  });
});

describe("release distribution (design 14)", () => {
  beforeAll(async () => {
    await env.rbox_releases.put("releases/version.json", '{"version":"0.0.2"}');
    await env.rbox_releases.put("releases/version.json.sig", "sig-bytes");
    await env.rbox_releases.put("releases/install.sh", "#!/bin/sh\n");
    await env.rbox_releases.put("releases/rbox-linux-x64", "LATEST-BIN");
    await env.rbox_releases.put("releases/v0.0.2/rbox-linux-x64", "VERSIONED-BIN");
  });

  test("/version + /version.sig serve from the release bucket, no-cache", async () => {
    const v = await SELF.fetch(`${BASE}/version`);
    expect(v.status).toBe(200);
    expect(v.headers.get("cache-control")).toBe("no-cache");
    expect(((await v.json()) as { version: string }).version).toBe("0.0.2");
    expect((await SELF.fetch(`${BASE}/version.sig`)).status).toBe(200);
  });

  test("versioned binary is immutable-cached; latest alias is short-cached", async () => {
    const versioned = await SELF.fetch(`${BASE}/bin/v0.0.2/rbox-linux-x64`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("cache-control")).toContain("immutable");
    expect(await versioned.text()).toBe("VERSIONED-BIN");
    const latest = await SELF.fetch(`${BASE}/bin/rbox-linux-x64`);
    expect(latest.status).toBe(200);
    expect(latest.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("rejects bad name / bad version / path traversal; 404s are no-store", async () => {
    for (const bad of ["/bin/evil", "/bin/v0.0.2/evil", "/bin/notaversion/rbox-linux-x64", "/bin/rbox-windows-x64"]) {
      const r = await SELF.fetch(`${BASE}${bad}`);
      expect(r.status).toBe(404);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    const missing = await SELF.fetch(`${BASE}/bin/v9.9.9/rbox-linux-x64`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });
});
