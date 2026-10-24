<script lang="ts">
	import { onMount } from 'svelte';
	import PasswordInput from '$lib/PasswordInput.svelte';
	import { pageTitle } from '$lib/app-shell';
	let timeZone = $state('UTC');
	onMount(() => {
		timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	});
</script>

<svelte:head><title>{pageTitle('Export your data')}</title></svelte:head>
<main class="mx-auto max-w-lg space-y-6 px-4 py-6">
	<a href="/account" class="inline-flex min-h-11 items-center text-indigo-300">← Account</a>
	<h1 class="text-2xl font-semibold">Your data, to take with you</h1>
	<p class="text-zinc-300">
		Keep a copy, open it in a spreadsheet, or give it to an agent you choose. Downloads go to your
		device; DocLifts does not send them to another app.
	</p>
	<p class="text-sm text-zinc-400">
		The native exports include notes and pain records, unfinished workouts and Trash. Photo records
		are included; image files are not. Passwords and agent credentials are never included. Keep the
		files somewhere private.
	</p>
	<form method="POST" action="/account/export/download" class="space-y-5">
		<PasswordInput
			id="export-password"
			name="password"
			label="Current password"
			autocomplete="current-password"
			required
			maxlength={128}
		/>
		<section
			class="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
			aria-labelledby="json-heading"
		>
			<h2 id="json-heading" class="font-semibold">DocLifts JSON</h2>
			<p class="text-sm text-zinc-300">
				The detailed record: workouts, programs and their history, gyms, machines, imported
				notebooks, notes and AI results. Keeps original values, IDs, units and uncertainty, with a
				data dictionary for your tools.
			</p>
			<p class="text-sm text-zinc-400">
				Best for keeping the full context. Re-importing this file into DocLifts is not available
				yet.
			</p>
			<button
				name="format"
				value="json"
				class="min-h-11 w-full rounded-lg bg-indigo-600 px-4 font-semibold text-white"
				>Download JSON</button
			>
		</section>
		<section
			class="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
			aria-labelledby="csv-heading"
		>
			<h2 id="csv-heading" class="font-semibold">Spreadsheet tables</h2>
			<p class="text-sm text-zinc-300">
				A ZIP of CSV files for Excel, Sheets and other tools. Start with workout_sets.csv and
				notebook_sets.csv; the other tables preserve the supporting records. Includes a field guide.
			</p>
			<p class="text-sm text-zinc-400">
				Loads stay in pounds. Text that could run as a spreadsheet formula gets a protective
				apostrophe; JSON keeps the exact original text.
			</p>
			<button
				name="format"
				value="csv"
				class="min-h-11 w-full rounded-lg border border-indigo-400 px-4 font-semibold text-indigo-200"
				>Download CSV tables</button
			>
		</section>
		<section
			class="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
			aria-labelledby="strong-heading"
		>
			<h2 id="strong-heading" class="font-semibold">Strong-style CSV · Experimental</h2>
			<p class="text-sm text-zinc-300">
				For tools that read the classic Strong workout format. Exports entered sets from ended app
				workouts in kilograms. Skips Trash, blank or zero-rep sets, unfinished workouts and imported
				notebooks. Programs and photos do not travel in this format.
			</p>
			<p class="text-sm text-zinc-400">
				Machine labels and weight bases stay in exercise names and notes. Per-side and per-arm loads
				are not doubled; RIR stays in notes rather than being guessed as RPE. Destination apps may
				drop these details. Review imported weights and names before relying on them.
			</p>
			<p class="text-sm text-zinc-400">
				Hevy officially supports direct Strong exports only. This converted file has not yet passed
				a real Hevy import. Strong itself does not import CSV.
			</p>
			<label class="block text-sm"
				>Time zone for Strong dates<input
					name="timeZone"
					bind:value={timeZone}
					maxlength="80"
					required
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					class="mt-2 min-h-11 w-full rounded border border-zinc-600 bg-zinc-950 px-3"
				/></label
			>
			<button
				name="format"
				value="strong"
				class="min-h-11 w-full rounded-lg border border-indigo-400 px-4 font-semibold text-indigo-200"
				>Download Strong-style CSV</button
			>
			<a
				class="inline-flex min-h-11 items-center text-sm text-indigo-300 underline"
				href="https://help.hevyapp.com/hc/en-us/articles/35687878672663-Importing-Strong-Data-into-Hevy"
				>Hevy import guidance ↗</a
			>
		</section>
	</form>
</main>
