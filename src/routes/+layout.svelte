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
	class="mx-auto flex max-w-lg gap-4 px-4 pt-3 text-sm text-indigo-300"
>
	<a href="/">Home</a><a href="/gyms">Gyms and machines</a><a href="/reports">Reports</a>
</nav>
{@render children()}
