import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the env-reading config + the clerk helper so api.ts loads in isolation.
vi.mock('$lib/config', () => ({ config: { apiBase: 'https://api.test' } }));
vi.mock('$lib/clerk', () => ({ sessionId: (c: { session?: { id?: string } }) => c?.session?.id ?? null }));

import { fetchUsage, clearStaleTokens } from './api';

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
const usageBody = { plan: 'pro', usedBytes: 0, storageCap: 1, workspaces: 0, workspaceCap: null, retentionDays: 90 };
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
