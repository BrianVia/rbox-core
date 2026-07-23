import type { Clerk } from '@clerk/clerk-js';
import {
	approveDeviceAuth,
	lookupDeviceAuthPubkeys,
	type DeviceAuthPubkeys
} from '$lib/api';
import { freshClerkStepUpToken } from '$lib/clerk';

const FINGERPRINT_RE = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type FingerprintFragment =
	| { kind: 'absent' }
	| { kind: 'invalid' }
	| { kind: 'present'; fingerprint: string };

export type DeviceKeyConsentProof = { pubkeyFingerprint: string; clerkToken: string };

export type VerifiedDeviceKeyConsent =
	| { status: 'match'; proof: DeviceKeyConsentProof }
	| { status: 'mismatch' };

export type PendingApprovalPhase = 'verify' | 'confirm' | 'mismatch';

/** Read the CLI's public-key binding from a URL fragment. An unrelated fragment
 *  is the manual-navigation path; a present-but-malformed fp fails closed. */
export function fingerprintFromHash(hash: string): FingerprintFragment {
	const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
	const params = new URLSearchParams(fragment);
	if (!params.has('fp')) return { kind: 'absent' };
	const fingerprint = params.get('fp') ?? '';
	return FINGERPRINT_RE.test(fingerprint)
		? { kind: 'present', fingerprint }
		: { kind: 'invalid' };
}

/** Rebuild the signed-out return target without losing the fragment. The target
 *  remains an internal path and is validated again by safeInternalPath at "/". */
export function cliLoginReturnPath(userCode: string, hash: string): string {
	const query = userCode ? `?code=${encodeURIComponent(userCode)}` : '';
	return `/cli-login${query}${hash.startsWith('#') ? hash : ''}`;
}

/** Initial pending-request state. A fragment-bearing request must pass the
 *  verification gate before the consent surface exists. */
export function pendingApprovalPhase(binding: FingerprintFragment): PendingApprovalPhase {
	if (binding.kind === 'invalid') return 'mismatch';
	if (binding.kind === 'present') return 'verify';
	return 'confirm';
}

export function approvalPageDescription(
	phase: PendingApprovalPhase | 'loading' | 'approved' | 'missing' | 'error',
	binding: FingerprintFragment
): string {
	if (phase === 'mismatch') return 'This request cannot be approved.';
	if (phase === 'approved') return 'Return to this machine to finish connecting it.';
	if (phase === 'missing') return 'This sign-in request is no longer available.';
	if (phase === 'error') return 'We couldn’t check this sign-in request.';
	if (phase === 'loading') return 'Checking this sign-in request.';
	if (binding.kind === 'present') {
		return 'Approve this sign-in and send the machine your encryption keys.';
	}
	return 'Approve this machine to sign in to your rbox account.';
}

function assertPublicKeys(keys: DeviceAuthPubkeys): void {
	if (
		!keys.encPubKeySpki ||
		!BASE64URL_RE.test(keys.encPubKeySpki) ||
		!keys.sigPubKey ||
		!BASE64URL_RE.test(keys.sigPubKey)
	) {
		throw new Error('The machine sent an invalid encryption request. Start `rbox login` again.');
	}
}

/** RFC 8785/JCS for this exact two-string object. Both member names are already
 *  in lexical order, and base64url values require no JSON escaping. */
export function canonicalDevicePubkeys(keys: DeviceAuthPubkeys): string {
	assertPublicKeys(keys);
	return JSON.stringify({
		encPubKeySpki: keys.encPubKeySpki,
		sigPubKey: keys.sigPubKey
	});
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url(sha256(JCS({encPubKeySpki, sigPubKey}))). */
export async function fingerprintDevicePubkeys(keys: DeviceAuthPubkeys): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalDevicePubkeys(keys))
	);
	return base64url(new Uint8Array(digest));
}

function fingerprintsEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let i = 0; i < left.length; i++) {
		difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return difference === 0;
}

/** Prepare the key-consent surface: fresh Clerk reverification happens first,
 *  then the browser verifies the echoed public keys. Only an exact match returns
 *  the in-memory proof that can be attached to a later explicit approval tap. */
export async function verifyDeviceKeyConsent(
	clerk: Clerk,
	userCode: string,
	expectedFingerprint: string
): Promise<VerifiedDeviceKeyConsent> {
	const clerkToken = await freshClerkStepUpToken(clerk);
	const keys = await lookupDeviceAuthPubkeys(userCode);
	if (!keys) return { status: 'mismatch' };

	const actualFingerprint = await fingerprintDevicePubkeys(keys);
	if (!fingerprintsEqual(actualFingerprint, expectedFingerprint)) {
		return { status: 'mismatch' };
	}
	return {
		status: 'match',
		proof: { pubkeyFingerprint: actualFingerprint, clerkToken }
	};
}

/** Submit the user's final consent. Manual navigation remains the exact legacy
 *  body; a fragment-bearing request cannot submit without its verified proof. */
export async function submitDeviceApproval(
	clerk: Clerk,
	userCode: string,
	binding: FingerprintFragment,
	proof: DeviceKeyConsentProof | null
): Promise<void> {
	if (binding.kind === 'absent') {
		await approveDeviceAuth(clerk, userCode);
		return;
	}
	if (
		binding.kind !== 'present' ||
		!proof ||
		!fingerprintsEqual(binding.fingerprint, proof.pubkeyFingerprint)
	) {
		throw new Error('This request hasn’t been verified. Nothing was approved.');
	}
	await approveDeviceAuth(clerk, userCode, proof);
}
