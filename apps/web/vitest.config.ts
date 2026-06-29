import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Unit tests run against plain modules (no SvelteKit plugin) — they mock $lib/config
// and $lib/clerk, so the env-reading config never loads.
export default defineConfig({
	test: { environment: 'node', include: ['src/**/*.test.ts'] },
	resolve: { alias: { $lib: resolve('./src/lib') } }
});
