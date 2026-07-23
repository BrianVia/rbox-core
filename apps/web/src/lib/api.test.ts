import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the env-reading config + the clerk helper so api.ts loads in isolation.
vi.mock('$lib/config', () => ({ config: { apiBase: 'https://api.test' } }));
vi.mock('$lib/clerk', () => ({ sessionId: (c: { session?: { id?: string } }) => c?.session?.id ?? null }));

import {
	fetchUsage,
	clearStaleTokens,
	lookupDeviceAuth,
	lookupDeviceAuthPubkeys,
	approveDeviceAuth,
	startCheckout,
	fetchApiKeys,
	revokeApiKey
} from './api';

function makeStorage() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		key: (i: number) => [...m.keys()][i] ?? null,
		get length() {
			return m.size;
		}
	};
}

let store: ReturnType<typeof makeStorage>;
const clerk = (sid: string) => ({ session: { id: sid, getToken: vi.fn(async () => `jwt_${sid}`) }, user: {} });
const usageBody = { plan: 'pro', usedBytes: 0, storageCap: 1, workspaces: 0, workspaceCap: null, retentionDays: 365 };
const sessionCalls = (m: ReturnType<typeof vi.fn>) =>
	m.mock.calls.filter((c) => String(c[0]).includes('/v1/web/session')).length;

beforeEach(() => {
	store = makeStorage();
	(globalThis as unknown as { sessionStorage: unknown }).sessionStorage = store;
});

describe('rbox token cache (B3 / SF1)', () => {
	it('clearStaleTokens keeps only the current session token', () => {
		store.setItem('rbox_token:A', 'tA');
		store.setItem('rbox_token:B', 'tB');
		store.setItem('unrelated', 'x');
		clearStaleTokens('A');
		expect(store.getItem('rbox_token:A')).toBe('tA');
		expect(store.getItem('rbox_token:B')).toBeNull();
		expect(store.getItem('unrelated')).toBe('x');
	});

	it('exchanges once, then reuses the cached token for the same session', async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) })
			.mockResolvedValue({ ok: true, status: 200, json: async () => usageBody });
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		await fetchUsage(clerk('A') as never);
		await fetchUsage(clerk('A') as never);
		expect(sessionCalls(f)).toBe(1);
	});

	it('shares ONE in-flight exchange across concurrent callers (refresh mutex)', async () => {
		let release!: () => void;
		const f = vi.fn((url: string) =>
			String(url).includes('/v1/web/session')
				? new Promise((res) => {
						release = () => res({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) });
					})
				: Promise.resolve({ ok: true, status: 200, json: async () => usageBody })
		);
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		const c = clerk('A');
		const both = Promise.all([fetchUsage(c as never), fetchUsage(c as never)]);
		await new Promise((r) => setTimeout(r, 10));
		release();
		await both;
		expect(sessionCalls(f)).toBe(1);
	});

	it('re-exchanges and retries the request exactly once on 401', async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_old' }) })
			.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_new' }) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => usageBody });
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		const u = await fetchUsage(clerk('A') as never);
		expect(u.plan).toBe('pro');
		expect(sessionCalls(f)).toBe(2);
	});

	it('does not hand a concurrent different-session caller the in-flight token (B3)', async () => {
		// A's exchange is in flight when B asks — B must mint its OWN token, never
		// receive A's shared promise.
		let releaseA!: () => void;
		const f = vi.fn((url: string, init?: RequestInit) => {
			if (String(url).includes('/v1/web/session')) {
				const who = JSON.parse(init!.body as string).token; // jwt_A | jwt_B
				return who === 'jwt_A'
					? new Promise((res) => {
							releaseA = () => res({ ok: true, status: 200, json: async () => ({ token: 'tok_A' }) });
						})
					: Promise.resolve({ ok: true, status: 200, json: async () => ({ token: 'tok_B' }) });
			}
			return Promise.resolve({ ok: true, status: 200, json: async () => usageBody });
		});
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		const both = Promise.all([fetchUsage(clerk('A') as never), fetchUsage(clerk('B') as never)]);
		await new Promise((r) => setTimeout(r, 10));
		releaseA();
		await both;
		expect(store.getItem('rbox_token:A')).toBe('tok_A');
		expect(store.getItem('rbox_token:B')).toBe('tok_B'); // B minted its own, not A's
	});

	it('never reuses another session’s token (per-session cache)', async () => {
		store.setItem('rbox_token:A', 'tokenA'); // A is cached
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'tokenB' }) })
			.mockResolvedValue({ ok: true, status: 200, json: async () => usageBody });
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		await fetchUsage(clerk('B') as never); // B must exchange, not reuse A
		expect(store.getItem('rbox_token:B')).toBe('tokenB');
		const usageCall = f.mock.calls.find((c) => String(c[0]).includes('/v1/account/usage'));
		expect((usageCall![1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer tokenB' });
	});
});

describe('billing checkout', () => {
	it('POSTs plan and cadence, then returns the checkout URL', async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ url: 'https://checkout.test/session' }) });
		(globalThis as unknown as { fetch: unknown }).fetch = f;

		await expect(startCheckout(clerk('A') as never, 'solo', 'annual')).resolves.toBe('https://checkout.test/session');

		const call = f.mock.calls.find((c) => String(c[0]).includes('/v1/billing/checkout'));
		expect(call).toBeTruthy();
		expect(String(call![0])).toBe('https://api.test/v1/billing/checkout?plan=solo&cadence=annual');
		expect((call![1] as RequestInit).method).toBe('POST');
	});

	it('defaults checkout cadence to monthly', async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ url: 'https://checkout.test/session' }) });
		(globalThis as unknown as { fetch: unknown }).fetch = f;

		await startCheckout(clerk('A') as never, 'pro');

		const call = f.mock.calls.find((c) => String(c[0]).includes('/v1/billing/checkout'));
		expect(String(call![0])).toBe('https://api.test/v1/billing/checkout?plan=pro&cadence=monthly');
	});
});

describe('agent API keys', () => {
	it('GETs /v1/keys/api with the rbox web bearer and returns camelCase rows', async () => {
		const key = {
			deviceId: 'key_dev_1',
			label: 'deploy',
			displayPrefix: 'rbox_pat_pNFofOvu...',
			createdAt: 10,
			lastSeenAt: 20,
			expiresAt: 30,
			revoked: false
		};
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ keys: [key] }) });
		(globalThis as unknown as { fetch: unknown }).fetch = f;

		await expect(fetchApiKeys(clerk('A') as never)).resolves.toEqual([key]);

		const call = f.mock.calls.find((c) => String(c[0]).includes('/v1/keys/api'));
		expect(call).toBeTruthy();
		expect(String(call![0])).toBe('https://api.test/v1/keys/api');
		expect((call![1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer rbox_A' });
	});

	it('POSTs key revocation to /v1/keys/api/:deviceId/revoke', async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
		(globalThis as unknown as { fetch: unknown }).fetch = f;

		await revokeApiKey(clerk('A') as never, 'key/dev 1');

		const call = f.mock.calls.find((c) => String(c[0]).includes('/v1/keys/api/'));
		expect(call).toBeTruthy();
		expect(String(call![0])).toBe('https://api.test/v1/keys/api/key%2Fdev%201/revoke');
		const init = call![1] as RequestInit;
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({ authorization: 'Bearer rbox_A' });
	});
});

describe('CLI browser login — device-code (design 47)', () => {
	it('lookup returns { label, status } for a pending code — public, no bearer, no exchange', async () => {
		const f = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, json: async () => ({ label: 'my-macbook', status: 'pending' }) });
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		const r = await lookupDeviceAuth('ABCD-2345');
		expect(r).toEqual({ label: 'my-macbook', status: 'pending' });
		// It's the deliberately-public route: no session exchange, no Authorization header.
		expect(sessionCalls(f)).toBe(0);
		expect(String(f.mock.calls[0][0])).toContain('/v1/auth/device/lookup?code=ABCD-2345');
		const init = f.mock.calls[0][1] as RequestInit | undefined;
		expect((init?.headers ?? {}) as Record<string, string>).not.toHaveProperty('authorization');
	});

	it('lookup surfaces an already-approved code (e.g. a page refresh after confirming)', async () => {
		const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ label: null, status: 'approved' }) });
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		expect(await lookupDeviceAuth('WXYZ-6789')).toEqual({ label: null, status: 'approved' });
	});

	it('lookup returns null on 404 (expired or unknown code)', async () => {
		const f = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) });
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		expect(await lookupDeviceAuth('ZZZZ-0000')).toBeNull();
	});

	it('pubkeys echo is public and sends no bearer or session exchange', async () => {
		const keys = { encPubKeySpki: 'ZW5j', sigPubKey: 'c2ln' };
		const f = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, json: async () => keys });
		(globalThis as unknown as { fetch: unknown }).fetch = f;

		await expect(lookupDeviceAuthPubkeys('ABCD-2345')).resolves.toEqual(keys);
		expect(sessionCalls(f)).toBe(0);
		expect(String(f.mock.calls[0][0])).toBe(
			'https://api.test/v1/auth/device/pubkeys?code=ABCD-2345'
		);
		expect((f.mock.calls[0][1] as RequestInit | undefined)?.headers ?? {}).not.toHaveProperty(
			'authorization'
		);
	});

	it('absent fragment uses exact device-auth-only body with the rbox web bearer', async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) }) // session exchange
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) }); // approve
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		await approveDeviceAuth(clerk('A') as never, 'ABCD-2345');
		const call = f.mock.calls.find((c) => String(c[0]).includes('/v1/auth/device/approve'));
		expect(call).toBeTruthy();
		const init = call![1] as RequestInit;
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ userCode: 'ABCD-2345' });
		expect(init.headers).toMatchObject({ authorization: 'Bearer rbox_A' });
	});

	it('key approval POSTs the exact consent proof with a fresh Clerk JWT', async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, keyDelivery: { status: 'pending' } })
			});
		(globalThis as unknown as { fetch: unknown }).fetch = f;

		await approveDeviceAuth(clerk('A') as never, 'ABCD-2345', {
			pubkeyFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			clerkToken: 'fresh_clerk_jwt'
		});

		const call = f.mock.calls.find((c) => String(c[0]).includes('/v1/auth/device/approve'));
		const init = call![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({
			userCode: 'ABCD-2345',
			keyConsent: true,
			pubkeyFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			clerkToken: 'fresh_clerk_jwt'
		});
		expect(init.headers).toMatchObject({ authorization: 'Bearer rbox_A' });
	});

	it('approve maps 404 (no pending auth) to a clear, actionable error', async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'rbox_A' }) })
			.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'no_pending_auth' }) });
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		await expect(approveDeviceAuth(clerk('A') as never, 'GONE-0000')).rejects.toThrow(/expired|already/i);
	});
});
