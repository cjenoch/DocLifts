<script lang="ts">
	import './layout.css';
	// Served from static/, not imported: Vite inlines small imported assets as
	// data: URIs, which the CSP's img-src 'self' blocks (e2e finding, 2026-09-29).

	let { children, data } = $props();
</script>

<svelte:head><link rel="icon" href="/favicon.svg" /></svelte:head>
{#if data.demoMode}<div class="bg-indigo-950 px-4 py-2 text-center text-sm text-indigo-100">
		Demo · Fictional workouts · Changes are temporary
	</div>{/if}
<nav
	aria-label="Main navigation"
	class="mx-auto flex max-w-lg items-center gap-4 px-4 pt-3 text-sm text-indigo-300"
>
	<a href="/">Home</a><a href="/gyms">Gyms and machines</a><a href="/reports">Reports</a>

	<!--
		The sign-out control. The POST action existed and worked the whole time
		and was simply never rendered anywhere, so there was no way to log out
		from the UI at all — found 2026-09-30, when signing out of the released
		app was the first thing tried and the first thing missing.

		A <form method="POST" action="/logout"> and not an <a href>: the route
		answers 405 to GET on purpose, so a link, a prefetch, or an <img> can
		never sign somebody out by merely being loaded. See src/routes/logout.

		`data.user` comes from the layout load, which reads `locals.user` — set
		by the guard in hooks.server.ts. No extra session lookup: the guard has
		already done it for every non-public request.
	-->
	{#if data.user}
		<form method="POST" action="/logout" class="ml-auto">
			<button
				type="submit"
				class="rounded border border-indigo-700 px-2 py-0.5 text-xs font-semibold text-indigo-200 active:bg-indigo-900"
				>Sign out</button
			>
		</form>
	{/if}
</nav>
{@render children()}
