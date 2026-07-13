import { describe, expect, it } from 'vitest';
import type { ApiKey } from '$lib/api';

import { apiKeyStatus, isApiKeyExpiringSoon } from './api-keys-section';

const now = Date.UTC(2026, 6, 8);
const day = 24 * 60 * 60 * 1000;

const key = (overrides: Partial<ApiKey> = {}): ApiKey => ({
	deviceId: 'key_1',
	label: 'deploy',
	displayPrefix: 'rbox_pat_pNFofOvu...',
	createdAt: now - 30 * day,
	lastSeenAt: now - 3 * 60 * 1000,
	expiresAt: now + 30 * day,
	revoked: false,
	...overrides
});

describe('ApiKeysSection behavior', () => {
	it('marks active keys expiring in less than seven days for the highlighted expires cell', () => {
		const expiring = key({ expiresAt: now + 6 * day });
		const later = key({ expiresAt: now + 8 * day });
		const revoked = key({ expiresAt: now + 6 * day, revoked: true });

		expect(apiKeyStatus(expiring, now)).toBe('active');
		expect(isApiKeyExpiringSoon(expiring, now)).toBe(true);
		expect(isApiKeyExpiringSoon(later, now)).toBe(false);
		expect(isApiKeyExpiringSoon(revoked, now)).toBe(false);
	});

	it('does not mark keys expiring exactly seven days from now as expiring soon', () => {
		expect(isApiKeyExpiringSoon(key({ expiresAt: now + 7 * day }), now)).toBe(false);
	});

	it('marks keys expiring one millisecond before seven days from now as expiring soon', () => {
		expect(isApiKeyExpiringSoon(key({ expiresAt: now + 7 * day - 1 }), now)).toBe(true);
	});
});
