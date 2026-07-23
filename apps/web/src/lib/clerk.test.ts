import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config', () => ({
	config: {
		clerkPublishableKey: 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk'
	}
}));

import { freshClerkStepUpToken } from './clerk';

function stepUpClerk() {
	const getToken = vi.fn(async () => 'fresh_jwt');
	const clerk = {
		session: { id: 'sess_A', getToken },
		__internal_openReverification: vi.fn()
	};
	return { clerk, getToken };
}

describe('fresh Clerk step-up', () => {
	it('does not mint the JWT until multi-factor reverification succeeds', async () => {
		const { clerk, getToken } = stepUpClerk();
		const pending = freshClerkStepUpToken(clerk as never);

		expect(clerk.__internal_openReverification).toHaveBeenCalledWith(
			expect.objectContaining({ level: 'multi_factor' })
		);
		expect(getToken).not.toHaveBeenCalled();

		const callbacks = clerk.__internal_openReverification.mock.calls[0][0];
		callbacks.afterVerification();

		await expect(pending).resolves.toBe('fresh_jwt');
		expect(getToken).toHaveBeenCalledWith({ skipCache: true });
	});

	it('reverification cancellation returns no token', async () => {
		const { clerk, getToken } = stepUpClerk();
		const pending = freshClerkStepUpToken(clerk as never);
		const callbacks = clerk.__internal_openReverification.mock.calls[0][0];
		callbacks.afterVerificationCancelled();

		await expect(pending).rejects.toThrow(/cancelled/i);
		expect(getToken).not.toHaveBeenCalled();
	});
});
