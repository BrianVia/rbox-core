import type { ApiKey } from '$lib/api';
import { relativeTime } from '$lib/format';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export function apiKeyStatus(key: ApiKey, now: number = Date.now()): ApiKeyStatus {
	if (key.revoked) return 'revoked';
	if (key.expiresAt <= now) return 'expired';
	return 'active';
}

export function isApiKeyExpiringSoon(key: ApiKey, now: number = Date.now()): boolean {
	return apiKeyStatus(key, now) === 'active' && key.expiresAt - now < SEVEN_DAYS_MS;
}

export function apiKeyLastSeenLabel(lastSeenAt: number | null, now: number = Date.now()): string {
	return lastSeenAt == null ? 'never active' : `active ${relativeTime(lastSeenAt, now)}`;
}
