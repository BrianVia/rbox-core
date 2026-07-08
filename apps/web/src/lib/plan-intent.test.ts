import { describe, it, expect, beforeEach } from 'vitest';
import { stashPlanIntent, consumePlanIntent, PLAN_INTENT_TTL_MS } from './plan-intent';

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
const setStorage = (s: unknown) =>
	((globalThis as unknown as { sessionStorage: unknown }).sessionStorage = s);

beforeEach(() => {
	store = makeStorage();
	setStorage(store);
});

describe('plan intent handoff', () => {
	it('stashes only solo/pro; ignores team, junk, and empty', () => {
		for (const bad of ['team', 'none', 'PRO', 'solo ', '', 'enterprise', null]) {
			expect(stashPlanIntent(bad)).toBe(false);
			expect(consumePlanIntent()).toBeNull();
		}
		expect(stashPlanIntent('solo')).toBe(true);
		expect(consumePlanIntent()).toEqual({ plan: 'solo', cadence: 'monthly' });
		expect(stashPlanIntent('pro')).toBe(true);
		expect(consumePlanIntent()).toEqual({ plan: 'pro', cadence: 'monthly' });
	});

	it('stores annual cadence and defaults missing or junk cadence to monthly', () => {
		expect(stashPlanIntent('solo', 'annual')).toBe(true);
		expect(consumePlanIntent()).toEqual({ plan: 'solo', cadence: 'annual' });
		expect(stashPlanIntent('pro', 'weekly')).toBe(true);
		expect(consumePlanIntent()).toEqual({ plan: 'pro', cadence: 'monthly' });
	});

	it('consume is one-shot — a second read returns null (cancel must not re-fire)', () => {
		stashPlanIntent('pro');
		expect(consumePlanIntent()).toEqual({ plan: 'pro', cadence: 'monthly' });
		expect(consumePlanIntent()).toBeNull();
	});

	it('honors the TTL: consumable right up to 30min, null (and cleared) after', () => {
		const t0 = 1_700_000_000_000; // injected clock — no sleeping in tests
		stashPlanIntent('pro', null, t0);
		expect(consumePlanIntent(t0 + PLAN_INTENT_TTL_MS)).toEqual({ plan: 'pro', cadence: 'monthly' }); // boundary: still fresh

		stashPlanIntent('pro', null, t0);
		expect(consumePlanIntent(t0 + PLAN_INTENT_TTL_MS + 1)).toBeNull(); // expired
		expect(store.length).toBe(0); // and cleared, not left to rot
	});

	it('returns null (and clears) on garbage stored values without throwing', () => {
		// legacy plain string, non-JSON, missing timestamp, invalid plan
		for (const junk of ['pro', 'not json{', '{"plan":"pro"}', `{"plan":"team","at":${Date.now()}}`]) {
			store.setItem('rbox_plan_intent', junk);
			expect(consumePlanIntent()).toBeNull();
			expect(store.length).toBe(0);
		}
	});

	it('degrades to a no-op when sessionStorage throws (e.g. Safari private mode)', () => {
		setStorage({
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('SecurityError');
			},
			removeItem: () => {
				throw new Error('SecurityError');
			}
		});
		expect(stashPlanIntent('pro')).toBe(false);
		expect(consumePlanIntent()).toBeNull();
	});
});
