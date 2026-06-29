import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Pure client-rendered SPA → static assets deployed to the rbox-app Pages project.
// `fallback: '200.html'` makes every unknown path serve the app shell (SF2), so
// direct loads of /dashboard, /billing, /billing/success?... work. Pair with
// static/_redirects (`/* /200.html 200`) for Cloudflare Pages routing.
export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: '200.html', strict: false })
		})
	]
});
