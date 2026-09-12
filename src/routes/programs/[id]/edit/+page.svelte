<script lang="ts">
	import ProgramEditor from '$lib/components/ProgramEditor.svelte';
	import type { PageProps } from './$types';
	let { data, form }: PageProps = $props();
</script>

<ProgramEditor {data} {form} />
