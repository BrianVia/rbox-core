import { describe, it, expect } from 'vitest';
import { safeInternalPath } from './redirect';

describe('safeInternalPath (open-redirect guard)', () => {
	it('accepts same-origin internal paths incl. a nested query (the cli-login case)', () => {
		expect(safeInternalPath('/cli-login?code=HLB5-TLH7')).toBe('/cli-login?code=HLB5-TLH7');
		expect(safeInternalPath('/dashboard')).toBe('/dashboard');
	});
	it('keeps a cli-login fingerprint fragment on the validated internal path', () => {
		const path =
			'/cli-login?code=HLB5-TLH7#fp=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
		expect(safeInternalPath(path)).toBe(path);
	});
	it('rejects protocol-relative, backslash, absolute, and bare-host values', () => {
		for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'http://x', 'evil.com', ''])
			expect(safeInternalPath(bad)).toBeNull();
	});
	it('rejects null/undefined so the caller falls back to /dashboard', () => {
		expect(safeInternalPath(null)).toBeNull();
		expect(safeInternalPath(undefined)).toBeNull();
	});
});
