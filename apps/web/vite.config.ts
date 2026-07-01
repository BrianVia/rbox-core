import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Pure client-rendered SPA → static assets deployed to the rbox-app Pages project.
// `fallback: 'index.html'` makes every unknown path serve the app shell (SF2), so
// direct loads of /dashboard, /billing, /billing/success?... work. Paired with
// static/_redirects (`/* /index.html 200`). index.html (not 200.html) is the
// canonical directory index, so Cloudflare Pages' clean-URL handling doesn't
// redirect it — 200.html loops (/200.html → /200 → /* → /200.html). Safe here:
// prerender is off (no route emits a conflicting index.html) and there's no 404.html.
export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: 'index.html', strict: false })
		})
	]
});
