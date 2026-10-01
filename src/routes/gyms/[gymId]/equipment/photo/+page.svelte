<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { photoClientSettings, resizeForUpload } from '$lib/photo-client';
	import type { ActionData, PageData } from './$types';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	/** null when idle; the button's label while a submit is under way. */
	let stage: string | null = $state(null);
	const { labels } = photoClientSettings;

	// With JavaScript, the photo is resized on the phone before the POST
	// (src/lib/photo-client.ts), and the original goes instead on any failure.
	// Without it, the form posts the original, as it always has. The server
	// re-checks and re-processes every upload either way.
	const resizeThenUpload: SubmitFunction = async ({ formData, cancel }) => {
		if (stage) return cancel();
		stage = labels.preparing;
		const chosen = formData.get('photo');
		if (chosen instanceof File && chosen.size > 0) {
			const sent = await resizeForUpload(chosen);
			formData.set('photo', sent, sent.name);
			formData.set('clientOriginalBytes', String(chosen.size));
			formData.set('clientResized', sent === chosen ? '0' : '1');
		}
		stage = labels.uploading;
		return async ({ update }) => {
			// The default: a redirect goes to review, a refusal shows its message.
			try {
				await update();
			} finally {
				stage = null;
			}
		};
	};
</script>

<div class="mx-auto max-w-lg space-y-5 p-4">
	<a href="/gyms" class="text-indigo-300">← Gyms and machines</a>
	<h1 class="text-2xl font-semibold">Add a machine from a photo</h1>
	<p class="text-zinc-300">
		{data.gym.name}: take a photo of the machine's placard (the label with the maker and model
		code), or choose one you already took. You review what was read before anything is added.
	</p>
	{#if form?.message}<p role="status" class="text-amber-300">{form.message}</p>{/if}
	<form
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		class="space-y-3 rounded border border-zinc-700 p-4"
		use:enhance={resizeThenUpload}
	>
		<label class="block"
			>Photo<input
				type="file"
				name="photo"
				accept="image/jpeg,image/png,image/webp"
				required
				class="mt-1 block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		<label class="block"
			>Note (optional)<input
				type="text"
				name="note"
				maxlength="200"
				placeholder="e.g. the code is on the seat post"
				class="mt-1 block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		<button class="rounded bg-indigo-600 px-4 py-2" disabled={stage !== null}
			>{stage ?? 'Upload photo'}</button
		>
	</form>
	{#if data.waiting.length}
		<section class="space-y-1">
			<h2 class="font-semibold">Waiting for review</h2>
			<ul class="text-sm">
				{#each data.waiting as p (p.id)}<li>
						<a href={`/photos/${p.id}/review`} class="text-indigo-300"
							>Photo from {p.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</a
						>
						· {p.status === 'analyzed' ? 'read' : 'not read yet'}
					</li>{/each}
			</ul>
		</section>
	{/if}
	<p class="text-sm text-zinc-400">
		The photo is resized and its location and camera details are removed before it is stored. Only
		you can see it.
	</p>
</div>
