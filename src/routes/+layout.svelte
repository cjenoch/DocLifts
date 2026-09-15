<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
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
