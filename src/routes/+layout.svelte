<script lang="ts">
	import './layout.css';
	import { page } from '$app/state';
	import { accountInitial, activeTab, appShell } from '$lib/app-shell';
	// Icons and the manifest are served from static/, not imported: Vite
	// inlines small imported assets as data: URIs, which the CSP's img-src
	// 'self' blocks (e2e finding, 2026-09-29).

	let { children, data } = $props();

	// One bar at the bottom at a time (Part E): an open workout's own bar
	// (Pause, Add exercise, Finish) replaces the tabs. The session page says
	// so through its load (`workoutBar`).
	const showTabs = $derived(!!data.user && !page.data.workoutBar);
	const current = $derived(activeTab(page.url.pathname));
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
	<meta name="theme-color" content="#09090b" />
	<meta name="apple-mobile-web-app-title" content={appShell.appName} />
</svelte:head>
{#if data.demoMode}<div class="bg-indigo-950 px-4 py-2 text-center text-sm text-indigo-100">
		Demo · Fictional workouts · Changes are temporary
	</div>{/if}
{#if data.user}
	<!--
		The account button: one tap from any page (Part E). Password and Sign
		out live on /account now; Sign out is still a POST form there, never a
		link (see src/routes/account/+page.svelte).
	-->
	<header class="shell-header mx-auto flex max-w-lg items-center justify-between px-4">
		<a href="/" class="text-sm font-semibold tracking-wide text-zinc-300">{appShell.appName}</a>
		<a
			href="/account"
			aria-label={appShell.accountLabel}
			aria-current={page.url.pathname.startsWith('/account') ? 'page' : undefined}
			class="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-600 text-lg font-semibold text-white active:bg-indigo-500"
			>{accountInitial(data.user.email)}</a
		>
	</header>
{/if}
<div class={showTabs ? 'shell-tabs-clearance' : ''}>
	{@render children()}
</div>
{#if showTabs}
	<nav aria-label="Main navigation" class="shell-tabs">
		<ul class="mx-auto flex max-w-lg">
			{#each appShell.tabs as tab (tab.href)}
				<li class="flex-1">
					<a
						href={tab.href}
						aria-current={current?.href === tab.href ? 'page' : undefined}
						class="flex min-h-14 items-center justify-center px-1 text-sm font-semibold whitespace-nowrap {current?.href ===
						tab.href
							? 'text-indigo-200'
							: 'text-zinc-400'}">{tab.label}</a
					>
				</li>
			{/each}
		</ul>
	</nav>
{/if}
