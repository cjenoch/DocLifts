<script lang="ts">
	import { enhance } from '$app/forms';
	import { applyAction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { PHOTO_NOTICE_VERSION } from '$lib/photo-privacy';
	let { collapsed = false }: { collapsed?: boolean } = $props();
	let busy = $state(false);
	let message = $state('');
</script>

{#snippet notice()}
	<section
		aria-labelledby="photo-notice-heading"
		class="rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-sm text-zinc-300"
	>
		<h2 id="photo-notice-heading" class="text-base font-semibold text-zinc-100">
			Before your first photo
		</h2>
		<ul class="mt-3 list-disc space-y-2 pl-5">
			<li>
				An automated safety check screens each photo. An AI service then reads it to identify
				equipment. Screening may run on our server or through OpenRouter; identification uses
				OpenRouter and its model providers, under their own data handling.
			</li>
			<li>
				Embedded location and camera metadata are removed before storage or AI processing. Anything
				visible in the picture—including people, gym names and signs—stays in it.
			</li>
			<li>
				Your photos are not shown to other users. The operator and the services that host or process
				them can access data as needed to run the service.
			</li>
			<li>
				Keep people out of the frame. Photograph the machine or its label, and upload only photos
				you took or have the right to use.
			</li>
		</ul>
		<p class="mt-3">
			You can log exercises manually without sending photos. Saved photos cannot yet be deleted
			through the app; contact <a class="text-indigo-300 underline" href="mailto:support@runthe.ai"
				>support@runthe.ai</a
			> for a removal request.
		</p>
		<a
			class="mt-2 inline-flex min-h-11 items-center text-indigo-300 underline"
			href="/privacy"
			target="_blank"
			rel="noopener">Read the privacy notice (opens a new tab)</a
		>
		<form
			method="POST"
			action="?/acknowledgePhotoNotice"
			class="mt-2 space-y-3"
			use:enhance={() => {
				busy = true;
				message = '';
				return async ({ result }) => {
					try {
						if (result.type === 'success') await invalidateAll();
						else if (result.type === 'failure')
							message = String(result.data?.message ?? 'Please acknowledge the notice.');
						else if (result.type === 'redirect') await applyAction(result);
						else message = 'Could not save your acknowledgment. Please try again.';
					} catch {
						message = 'Could not save your acknowledgment. Please try again.';
					} finally {
						busy = false;
					}
				};
			}}
		>
			<input type="hidden" name="photoNoticeVersion" value={PHOTO_NOTICE_VERSION} />
			<label class="flex min-h-11 items-center gap-3"
				><input type="checkbox" name="acknowledge" value="yes" required class="h-5 w-5 shrink-0" />I
				understand how my photos will be processed.</label
			>
			{#if message}<p role="alert" class="text-amber-300">{message}</p>{/if}
			<button
				type="submit"
				disabled={busy}
				class="min-h-11 w-full rounded-lg bg-emerald-700 px-4 py-3 font-semibold text-white"
				>{busy ? 'Saving…' : 'Continue to photos'}</button
			>
		</form>
	</section>
{/snippet}
{#if collapsed}
	<details class="mb-2">
		<summary
			id="photo-next-input"
			class="flex min-h-12 cursor-pointer items-center justify-center rounded-lg bg-emerald-600 px-4 font-semibold text-white"
			>Photo next machine</summary
		>
		<div class="mt-2 max-h-[60dvh] overflow-y-auto overscroll-contain">{@render notice()}</div>
	</details>
{:else}
	{@render notice()}
{/if}
