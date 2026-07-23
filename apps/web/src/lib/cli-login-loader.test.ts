import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	returnPath: vi.fn(
		(code: string, hash: string) =>
			`/cli-login${code ? `?code=${encodeURIComponent(code)}` : ''}${hash}`
	),
	getClerk: vi.fn(),
	redirect: vi.fn((status: number, destination: string) => {
		throw Object.assign(new Error('redirect'), { status, destination });
	})
}));

vi.mock('$lib/clerk', () => ({ getClerk: mocks.getClerk }));
vi.mock('$lib/device-approval', () => ({ cliLoginReturnPath: mocks.returnPath }));
vi.mock('@sveltejs/kit', () => ({ redirect: mocks.redirect }));

import { load } from '../routes/cli-login/+page';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getClerk.mockResolvedValue({ user: null });
	Object.defineProperty(globalThis, 'location', {
		value: { hash: '#fp=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
		configurable: true
	});
});

describe('cli-login loader', () => {
	it('preserves the live #fp in the actual signed-out Clerk redirect', async () => {
		await expect(
			load({ url: new URL('https://app.test/cli-login?code=abcd-2345') } as never)
		).rejects.toMatchObject({ status: 307 });

		expect(mocks.returnPath).toHaveBeenCalledWith(
			'ABCD-2345',
			'#fp=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
		);
		expect(mocks.redirect).toHaveBeenCalledWith(
			307,
			'/?redirect_url=%2Fcli-login%3Fcode%3DABCD-2345%23fp%3DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
		);
	});
});
