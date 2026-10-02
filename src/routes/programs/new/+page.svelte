<script lang="ts">
	import ProgramEditor from '$lib/components/ProgramEditor.svelte';
	import type { PageProps } from './$types';
	import { pageTitle } from '$lib/app-shell';
	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>{pageTitle('New program')}</title></svelte:head>

<ProgramEditor {data} {form} />
