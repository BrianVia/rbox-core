import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	approve: vi.fn(),
	lookupPubkeys: vi.fn(),
	stepUp: vi.fn()
}));

vi.mock('$lib/api', () => ({
	approveDeviceAuth: mocks.approve,
	lookupDeviceAuthPubkeys: mocks.lookupPubkeys
}));
vi.mock('$lib/clerk', () => ({
	freshClerkStepUpToken: mocks.stepUp
}));

import {
	canonicalDevicePubkeys,
	cliLoginReturnPath,
	approvalPageDescription,
	fingerprintDevicePubkeys,
	fingerprintFromHash,
	pendingApprovalPhase,
	submitDeviceApproval,
	verifyDeviceKeyConsent
} from './device-approval';

const KEYS = { encPubKeySpki: 'ZW5j', sigPubKey: 'c2ln' };
const FINGERPRINT = '0lbF_wW2fzzkYTCBWtjm-OP4D7aODKkH68UTak3cmEM';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.stepUp.mockResolvedValue('fresh_clerk_jwt');
	mocks.lookupPubkeys.mockResolvedValue(KEYS);
	mocks.approve.mockResolvedValue(undefined);
});

describe('CLI login fragment binding', () => {
	it('preserves #fp across the signed-out cli-login redirect', () => {
		expect(cliLoginReturnPath('ABCD-2345', `#fp=${FINGERPRINT}`)).toBe(
			`/cli-login?code=ABCD-2345#fp=${FINGERPRINT}`
		);
	});

	it('distinguishes absent, malformed, and valid fingerprints', () => {
		expect(fingerprintFromHash('')).toEqual({ kind: 'absent' });
		expect(fingerprintFromHash('#section=help')).toEqual({ kind: 'absent' });
		expect(fingerprintFromHash('#fp=')).toEqual({ kind: 'invalid' });
		expect(fingerprintFromHash('#fp=not-a-fingerprint')).toEqual({ kind: 'invalid' });
		expect(fingerprintFromHash(`#fp=${FINGERPRINT}`)).toEqual({
			kind: 'present',
			fingerprint: FINGERPRINT
		});
	});

	it('does not expose key consent until a valid fragment passes verification', () => {
		const present = { kind: 'present', fingerprint: FINGERPRINT } as const;
		expect(pendingApprovalPhase(present)).toBe('verify');
		expect(pendingApprovalPhase({ kind: 'invalid' })).toBe('mismatch');
		expect(pendingApprovalPhase({ kind: 'absent' })).toBe('confirm');
		expect(approvalPageDescription('mismatch', present)).toBe(
			'This request cannot be approved.'
		);
		expect(approvalPageDescription('confirm', present)).toMatch(/send.*encryption keys/i);
	});
});

describe('WIRE-189 public-key fingerprint', () => {
	it('computes the WIRE-189 JCS fingerprint from a fixed known vector', async () => {
		expect(canonicalDevicePubkeys(KEYS)).toBe(
			'{"encPubKeySpki":"ZW5j","sigPubKey":"c2ln"}'
		);
		await expect(fingerprintDevicePubkeys(KEYS)).resolves.toBe(FINGERPRINT);
	});

	it('match yields an in-memory key-consent proof only after fresh step-up and echo', async () => {
		await expect(
			verifyDeviceKeyConsent({} as never, 'ABCD-2345', FINGERPRINT)
		).resolves.toEqual({
			status: 'match',
			proof: {
				pubkeyFingerprint: FINGERPRINT,
				clerkToken: 'fresh_clerk_jwt'
			}
		});
		expect(mocks.stepUp).toHaveBeenCalledOnce();
		expect(mocks.lookupPubkeys).toHaveBeenCalledWith('ABCD-2345');
		expect(mocks.stepUp.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.lookupPubkeys.mock.invocationCallOrder[0]
		);
	});

	it('mismatch never yields an approval proof', async () => {
		await expect(
			verifyDeviceKeyConsent(
				{} as never,
				'ABCD-2345',
				'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
			)
		).resolves.toEqual({ status: 'mismatch' });
	});

	it('missing echoed keys fail closed as a mismatch', async () => {
		mocks.lookupPubkeys.mockResolvedValue(null);
		await expect(
			verifyDeviceKeyConsent({} as never, 'ABCD-2345', FINGERPRINT)
		).resolves.toEqual({ status: 'mismatch' });
	});

	it('absent fragment uses device-auth-only approval and skips step-up and pubkeys', async () => {
		await submitDeviceApproval({} as never, 'ABCD-2345', { kind: 'absent' }, null);

		expect(mocks.approve).toHaveBeenCalledWith({}, 'ABCD-2345');
		expect(mocks.stepUp).not.toHaveBeenCalled();
		expect(mocks.lookupPubkeys).not.toHaveBeenCalled();
	});

	it('matched fragment submits the exact verified key-consent proof', async () => {
		const proof = {
			pubkeyFingerprint: FINGERPRINT,
			clerkToken: 'fresh_clerk_jwt'
		};
		await submitDeviceApproval(
			{} as never,
			'ABCD-2345',
			{ kind: 'present', fingerprint: FINGERPRINT },
			proof
		);

		expect(mocks.approve).toHaveBeenCalledWith({}, 'ABCD-2345', proof);
	});

	it('malformed or unverified fragments can never submit approval', async () => {
		await expect(
			submitDeviceApproval({} as never, 'ABCD-2345', { kind: 'invalid' }, null)
		).rejects.toThrow(/hasn.t been verified/i);
		await expect(
			submitDeviceApproval(
				{} as never,
				'ABCD-2345',
				{ kind: 'present', fingerprint: FINGERPRINT },
				null
			)
		).rejects.toThrow(/hasn.t been verified/i);
		expect(mocks.approve).not.toHaveBeenCalled();
	});
});
