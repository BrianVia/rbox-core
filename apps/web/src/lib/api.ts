// Typed client for the rbox worker API. Cross-origin to config.apiBase; the worker
// allowlists this origin for CORS via CLERK_ALLOWED_ORIGINS.
import type { Clerk } from '@clerk/clerk-js';
import { config } from './config';
import { sessionId } from './clerk';

export interface Usage {
	plan: string;
	usedBytes: number;
	storageCap: number | null; // null = unlimited
	workspaces: number;
	workspaceCap: number | null; // null = unlimited
	retentionDays: number;
}

// rbox bearer tokens are minted per Clerk session and are ~1h-lived. Cache them
// keyed by Clerk session id (B3) so account A's token can never survive a switch
// to account B; clearStaleTokens() drops everything that isn't the live session.
const TOKEN_PREFIX = 'rbox_token:';
const keyFor = (sid: string) => TOKEN_PREFIX + sid;

export function clearStaleTokens(currentSid: string | null): void {
	const keep = currentSid ? keyFor(currentSid) : null;
	for (let i = sessionStorage.length - 1; i >= 0; i--) {
		const k = sessionStorage.key(i);
		if (k && k.startsWith(TOKEN_PREFIX) && k !== keep) sessionStorage.removeItem(k);
	}
}

/** Drop the CURRENT session's cached rbox token so the next authed() call re-mints
 *  one. Used after unlink (design 22 §4.3): the old token now points at the account
 *  we just disconnected from (and is server-revoked), so the SPA must re-exchange
 *  against the fresh shell, not keep hitting X. */
export function clearCurrentToken(clerk: Clerk): void {
	const sid = sessionId(clerk);
	if (sid) sessionStorage.removeItem(keyFor(sid));
}

// One in-flight exchange per session (SF1): concurrent callers for the SAME Clerk
// session share its promise. It is keyed by sid so a caller that arrives mid-switch
// can never receive a promise that resolves to a different account's token (B3).
let refreshInflight: { sid: string; promise: Promise<string> } | null = null;

async function exchange(clerk: Clerk): Promise<string> {
	const sid = sessionId(clerk);
	if (!sid) throw new Error('not signed in');
	const cached = sessionStorage.getItem(keyFor(sid));
	if (cached) return cached;
	if (refreshInflight?.sid === sid) return refreshInflight.promise;
	const promise = (async () => {
		const clerkToken = await clerk.session!.getToken();
		if (!clerkToken) throw new Error('no Clerk session token');
		const res = await fetch(`${config.apiBase}/v1/web/session`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: clerkToken })
		});
		if (res.status === 404 || res.status === 501) throw new Error('WEB_AUTH_NOT_ENABLED');
		if (!res.ok) throw new Error(`session exchange failed (${res.status})`);
		const data = (await res.json()) as { token?: string; accountId?: string };
		if (!data.token) throw new Error('session exchange returned no token');
		sessionStorage.setItem(keyFor(sid), data.token);
		return data.token;
	})().finally(() => {
		if (refreshInflight?.sid === sid) refreshInflight = null;
	});
	refreshInflight = { sid, promise };
	return promise;
}

// Authed fetch with a single re-exchange + retry on 401 (SF1).
async function authed(clerk: Clerk, path: string, init: RequestInit = {}): Promise<Response> {
	const sid = sessionId(clerk);
	if (!sid) throw new Error('not signed in');
	const send = (token: string) =>
		fetch(`${config.apiBase}${path}`, {
			...init,
			headers: { ...init.headers, authorization: `Bearer ${token}` }
		});
	let res = await send(await exchange(clerk));
	if (res.status === 401) {
		sessionStorage.removeItem(keyFor(sid)); // stale/expired rbox token → re-mint once
		res = await send(await exchange(clerk));
	}
	return res;
}

export async function fetchUsage(clerk: Clerk): Promise<Usage> {
	const res = await authed(clerk, '/v1/account/usage');
	if (!res.ok) throw new Error(`usage failed (${res.status})`);
	return res.json() as Promise<Usage>;
}

// ── devices & workspaces (design 22 §2) ──────────────────────────────────────

export interface Device {
	deviceId: string;
	label: string | null;
	kind: 'cli' | 'web';
	createdAt: number;
	lastSeenAt: number | null;
	lastSeenVersion: string | null;
	isCurrent: boolean;
}
export interface Workspace {
	workspaceId: string;
	projectId: string;
	/** Opt-in, server-visible label the first host set at `rbox init` (default-off).
	 *  null = no name → the row keeps the private, zero-knowledge "root" display. */
	name: string | null;
	createdAt: number;
}
export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

export interface ApiKey {
	deviceId: string;
	label: string | null;
	displayPrefix: string;
	createdAt: number;
	lastSeenAt: number | null;
	expiresAt: number;
	revoked: boolean;
}

export async function fetchDevices(
	clerk: Clerk,
	opts: { include?: 'cli' | 'all'; cursor?: string | null } = {}
): Promise<Page<Device>> {
	const q = new URLSearchParams();
	if (opts.include) q.set('include', opts.include);
	if (opts.cursor) q.set('cursor', opts.cursor);
	const res = await authed(clerk, `/v1/account/devices${q.size ? `?${q}` : ''}`);
	if (res.status === 404 || res.status === 501) throw new Error('WEB_AUTH_NOT_ENABLED');
	if (!res.ok) throw new Error(`devices failed (${res.status})`);
	const data = (await res.json()) as { devices: Device[]; nextCursor: string | null };
	return { items: data.devices, nextCursor: data.nextCursor };
}

export async function fetchApiKeys(clerk: Clerk): Promise<ApiKey[]> {
	const res = await authed(clerk, '/v1/keys/api');
	if (res.status === 404 || res.status === 501) throw new Error('WEB_AUTH_NOT_ENABLED');
	if (!res.ok) throw new Error(`api keys failed (${res.status})`);
	const data = (await res.json()) as { keys: ApiKey[] };
	return data.keys;
}

export async function fetchWorkspaces(
	clerk: Clerk,
	opts: { cursor?: string | null } = {}
): Promise<Page<Workspace>> {
	const q = new URLSearchParams();
	if (opts.cursor) q.set('cursor', opts.cursor);
	const res = await authed(clerk, `/v1/account/workspaces${q.size ? `?${q}` : ''}`);
	if (res.status === 404 || res.status === 501) throw new Error('WEB_AUTH_NOT_ENABLED');
	if (!res.ok) throw new Error(`workspaces failed (${res.status})`);
	const data = (await res.json()) as { workspaces: Workspace[]; nextCursor: string | null };
	return { items: data.workspaces, nextCursor: data.nextCursor };
}

/** Whether a Clerk identity manages this account (drives the empty-state nudge). */
export async function fetchAccountStatus(clerk: Clerk): Promise<{ accountId: string; linked: boolean; signInMethod?: string | null }> {
	const res = await authed(clerk, '/v1/account/status');
	if (!res.ok) throw new Error(`status failed (${res.status})`);
	return res.json() as Promise<{ accountId: string; linked: boolean; signInMethod?: string | null }>;
}

/** Revoke a device's access (design 22 §4.1). ACCESS-ONLY — it cuts the device off
 *  the server but does NOT cryptographically evict its keys (E2EE epoch rotation is
 *  unbuilt). The UI copy must say so; this helper does not overpromise. */
export async function revokeDevice(clerk: Clerk, deviceId: string): Promise<void> {
	const res = await authed(clerk, `/v1/auth/devices/${encodeURIComponent(deviceId)}/revoke`, {
		method: 'POST'
	});
	if (res.status === 403) throw new Error('You don’t have permission to revoke this device.');
	if (res.status === 404) throw new Error('That device no longer exists.');
	if (!res.ok) throw new Error(`revoke failed (${res.status})`);
}

export async function revokeApiKey(clerk: Clerk, deviceId: string): Promise<void> {
	const res = await authed(clerk, `/v1/keys/api/${encodeURIComponent(deviceId)}/revoke`, {
		method: 'POST'
	});
	if (res.status === 403) throw new Error('You don’t have permission to revoke this key.');
	if (res.status === 404) throw new Error('That key no longer exists.');
	if (!res.ok) throw new Error(`revoke failed (${res.status})`);
}

/** Disconnect this dashboard login from its rbox account (design 21 §5.4 + 22 §4.3).
 *  The server also revokes the caller's live web session, so afterwards we drop the
 *  cached token → the next call re-exchanges against the fresh shell. */
export async function unlinkAccount(clerk: Clerk): Promise<string> {
	const res = await authed(clerk, '/v1/account/unlink', { method: 'POST' });
	if (res.status === 409) throw new Error('This account has billing — cancel the subscription before unlinking.');
	if (res.status === 404) throw new Error('This login isn’t linked to an rbox account.');
	if (!res.ok) throw new Error(`unlink failed (${res.status})`);
	clearCurrentToken(clerk); // old token now points at (and is revoked on) the disconnected account
	return ((await res.json()) as { account: string }).account;
}

/** Irreversibly delete this account + all its data (design 37). OWNER-ONLY and
 *  confirmation-gated: `confirm` must be the owner's email or the account id. On success the
 *  account is tombstoned immediately (every device/session revoked) and hard-purged after a
 *  grace window — so the caller MUST sign out afterward (the token is already dead). */
export async function deleteAccount(
	clerk: Clerk,
	confirm: string
): Promise<{ status: string; purgeAfter: number }> {
	const res = await authed(clerk, '/v1/account', {
		method: 'DELETE',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ confirm })
	});
	if (res.status === 400) throw new Error('That didn’t match — type your account email or account id exactly.');
	if (res.status === 403) throw new Error('Only the account owner can delete this account.');
	if (res.status === 404) throw new Error('This account no longer exists.');
	if (!res.ok) throw new Error(`delete failed (${res.status})`);
	return res.json() as Promise<{ status: string; purgeAfter: number }>;
}

export async function startCheckout(clerk: Clerk, plan: 'solo' | 'pro', cadence: 'monthly' | 'annual' = 'monthly'): Promise<string> {
	const q = new URLSearchParams({ plan, cadence });
	const res = await authed(clerk, `/v1/billing/checkout?${q}`, { method: 'POST' });
	if (!res.ok) throw new Error(`checkout failed (${res.status})`);
	const { url } = (await res.json()) as { url?: string };
	if (!url) throw new Error('checkout returned no URL');
	return url;
}

export async function openBillingPortal(clerk: Clerk): Promise<string> {
	const res = await authed(clerk, '/v1/billing/portal', { method: 'POST' });
	if (res.status === 409) throw new Error('No subscription yet — subscribe to a plan first.');
	if (!res.ok) throw new Error(`portal failed (${res.status})`);
	const { url } = (await res.json()) as { url?: string };
	if (!url) throw new Error('portal returned no URL');
	return url;
}

// ── CLI browser login (design 47) ────────────────────────────────────────────
// The CLI's device-code flow prints app.rbox.to/cli-login?code=XXXX-XXXX; the web
// confirm page reads the code, shows which device is asking, and approves it.

export interface DeviceAuthLookup {
	label: string | null;
	status: 'pending' | 'approved' | 'claimed';
}

/** PUBLIC, unauthenticated lookup for the /cli-login confirm page. Sends NO bearer:
 *  the userCode is guessable-but-inert and the route returns only a hostname label +
 *  status — never account/user ids or tokens. `null` = 404 (unknown, or expired while
 *  still pending). */
export async function lookupDeviceAuth(userCode: string): Promise<DeviceAuthLookup | null> {
	const res = await fetch(`${config.apiBase}/v1/auth/device/lookup?code=${encodeURIComponent(userCode)}`);
	if (res.status === 404 || res.status === 400) return null;
	if (!res.ok) throw new Error(`couldn’t look up this login (${res.status})`);
	return res.json() as Promise<DeviceAuthLookup>;
}

/** Approve a pending device-code login from this web session. Uses the rbox web
 *  bearer via authed() — the same POST `rbox device approve` makes; the server now
 *  admits it for kind=='web' principals (design 47 webTokenAllowed change). Grants
 *  only authorized-but-not-E2EE-enrolled access, exactly like CLI-to-CLI approval. */
export async function approveDeviceAuth(clerk: Clerk, userCode: string): Promise<void> {
	const res = await authed(clerk, '/v1/auth/device/approve', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ userCode })
	});
	// no_pending_auth: the row is no longer pending — expired, or already approved/
	// claimed by another approval between page-load and this click.
	if (res.status === 404)
		throw new Error('This code is no longer pending — it may have expired or already been approved. Run `rbox login` again.');
	if (!res.ok) throw new Error(`couldn’t approve this login (${res.status})`);
}

// ── account linking (design 21) ──────────────────────────────────────────────
// start/status/confirm authenticate by a FRESH Clerk JWT (re-verified server-side),
// NOT the rbox web token — so they send clerk.session.getToken() directly, never the
// cached rbox bearer. The rbox token can't prove a specific Clerk identity (§4.2).

export interface LinkStart {
	code: string;
	pollKey: string;
}
export interface LinkStatus {
	status: 'awaiting' | 'pending' | 'committed' | 'expired';
	pendingAccount: string | null;
	fingerprint: string | null;
}

async function clerkJwt(clerk: Clerk): Promise<string> {
	const t = await clerk.session?.getToken();
	if (!t) throw new Error('not signed in');
	return t;
}

/** Begin a link: mint a one-time code to type into `rbox account link <code>`. */
export async function startLink(clerk: Clerk): Promise<LinkStart> {
	const res = await fetch(`${config.apiBase}/v1/account/link/start`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ clerkToken: await clerkJwt(clerk) })
	});
	if (res.status === 409) throw new Error('Finish signing in first, then try linking again.');
	if (res.status === 429) throw new Error('Too many pending link codes — wait a few minutes and retry.');
	if (!res.ok) throw new Error(`couldn’t start linking (${res.status})`);
	return res.json() as Promise<LinkStart>;
}

/** Poll the proposed target a terminal redeemed the code onto (drives confirm). */
export async function pollLinkStatus(clerk: Clerk, pollKey: string): Promise<LinkStatus> {
	const res = await fetch(`${config.apiBase}/v1/account/link/status?pollKey=${encodeURIComponent(pollKey)}`, {
		headers: { authorization: `Bearer ${await clerkJwt(clerk)}` }
	});
	if (!res.ok) throw new Error(`couldn’t check link status (${res.status})`);
	return res.json() as Promise<LinkStatus>;
}

/** Approve the proposed target account — the phase-2 commit. */
export async function confirmLink(clerk: Clerk, pollKey: string): Promise<string> {
	const res = await fetch(`${config.apiBase}/v1/account/link/confirm`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ clerkToken: await clerkJwt(clerk), pollKey })
	});
	if (res.status === 409) {
		const { error } = (await res.json().catch(() => ({}))) as { error?: string };
		if (error === 'already_linked') throw new Error('This login already manages another account — unlink it first.');
		if (error === 'origin_account_has_state') throw new Error('Your web account already has data or billing — contact support to merge.');
		throw new Error('The link couldn’t be confirmed — start over.');
	}
	if (!res.ok) throw new Error(`couldn’t confirm the link (${res.status})`);
	return ((await res.json()) as { account: string }).account;
}
