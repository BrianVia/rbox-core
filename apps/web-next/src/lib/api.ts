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

// One in-flight exchange at a time (SF1): concurrent callers share the same promise.
let refreshInflight: Promise<string> | null = null;

async function exchange(clerk: Clerk): Promise<string> {
	const sid = sessionId(clerk);
	if (!sid) throw new Error('not signed in');
	const cached = sessionStorage.getItem(keyFor(sid));
	if (cached) return cached;
	if (refreshInflight) return refreshInflight;
	refreshInflight = (async () => {
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
		refreshInflight = null;
	});
	return refreshInflight;
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

export async function startCheckout(clerk: Clerk, plan: 'solo' | 'pro'): Promise<string> {
	const res = await authed(clerk, `/v1/billing/checkout?plan=${plan}`, { method: 'POST' });
	if (!res.ok) throw new Error(`checkout failed (${res.status})`);
	return (await res.json()).url as string;
}

export async function openBillingPortal(clerk: Clerk): Promise<string> {
	const res = await authed(clerk, '/v1/billing/portal', { method: 'POST' });
	if (res.status === 409) throw new Error('No subscription yet — subscribe to a plan first.');
	if (!res.ok) throw new Error(`portal failed (${res.status})`);
	return (await res.json()).url as string;
}
