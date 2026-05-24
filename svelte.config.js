import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// Disabled: single-user, Tailscale-only, no auth — no session cookies for
		// an attacker to ride. RE-ENABLE THIS the moment a login flow is added.
		csrf: { checkOrigin: false }
	}
};

export default config;
