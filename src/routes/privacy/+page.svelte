<script lang="ts">
	import { PHOTO_NOTICE_VERSION } from '$lib/photo-privacy';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<svelte:head
	><title>Privacy and your data · DocLifts</title><meta
		name="description"
		content="How DocLifts handles workout data, photos and connected agents during the Alpha."
	/></svelte:head
>
<main class="mx-auto max-w-2xl space-y-6 px-4 py-8 text-zinc-300">
	<a href="/" class="inline-flex min-h-11 items-center text-indigo-300">← DocLifts</a>
	<header>
		<h1 class="text-3xl font-semibold text-zinc-100">Privacy and your data</h1>
		<p class="mt-2 text-sm text-zinc-400">Alpha notice · Updated {PHOTO_NOTICE_VERSION}</p>
	</header>
	{#if data.deletionState}
		<section aria-labelledby="deletion-status" class="rounded border border-amber-700 p-4">
			<h2 id="deletion-status" class="font-semibold">
				Account deletion {data.deletionState === 'completed' ? 'completed' : 'pending'}
			</h2>
			<p>
				{data.deletionState === 'completed'
					? 'Your live account data and private photo objects have been removed. Backup and provider copies have separate limits.'
					: data.deletionState === 'needs_retry'
						? 'Your account is blocked from access. Cleanup needs an operator retry; it has not finished. Contact support@runthe.ai if you need help.'
						: 'Your account is blocked from access. Removal is queued and has not finished. This page shows the status on this browser for 30 days.'}
			</p>
		</section>
	{/if}
	<p>
		DocLifts is operated by Enoch AI LLC. We use your information to run your account, document your
		lifts, identify equipment when you upload a photo, and provide the agent access you authorize.
		This Alpha is intended for adults 18 and older.
	</p>
	<section aria-labelledby="collect">
		<h2 id="collect" class="text-xl font-semibold text-zinc-100">What you give us</h2>
		<p class="mt-2">
			We store your account name and email, a password hash, gyms and equipment, programs, planned
			and logged sets, workout dates, imported history, photos and any notes or pain records you
			enter. Notes can reveal health information and personal details. Only enter what you want this
			service to hold.
		</p>
		<p class="mt-2">
			We also keep session and connected-agent records, security and sign-in information such as IP
			addresses and user agents, and operational records such as upload timing, screening results,
			model usage, errors and costs. These help authenticate you, limit abuse and troubleshoot the
			service.
		</p>
	</section>
	<section aria-labelledby="photos">
		<h2 id="photos" class="text-xl font-semibold text-zinc-100">Photos and AI processing</h2>
		<p class="mt-2">
			Before a new photo is saved, the server rebuilds it as a JPEG and removes embedded location
			and camera metadata. People, gym names, signs and anything else visible remain in the image.
			Keep people out of the frame and photograph the machine or its label. Upload only photos you
			took or have the right to use.
		</p>
		<p class="mt-2">
			An automated safety check runs on our server or through OpenRouter as part of an Alpha
			comparison. A blocked photo or an unavailable check prevents photo storage and equipment
			identification. An external screening service may already have received the photo in order to
			check it. A check record can remain even when the image is refused.
		</p>
		<p class="mt-2">
			Accepted photos are stored privately. For identification, the photo and any identification
			note are sent through OpenRouter to a model provider. The current identification model is
			Google Gemini; screening can use Llama Guard through OpenRouter. Models and routing can change
			as the Alpha develops.
		</p>
		<p class="mt-2">
			OpenRouter and the providers it routes to have their own data practices. We do not currently
			promise zero provider retention or that provider inputs will never be used for training. Read <a
				href="https://openrouter.ai/privacy"
				class="text-indigo-300 underline"
				rel="noreferrer">OpenRouter’s privacy policy</a
			>. DocLifts currently has prompt-text logging disabled, but keeps structured model results and
			usage records.
		</p>
		<p class="mt-2">
			We record the photo notice version and the time you acknowledge it on your account. You can
			use manual workout logging without uploading photos or acknowledging photo processing.
		</p>
	</section>
	<section aria-labelledby="access">
		<h2 id="access" class="text-xl font-semibold text-zinc-100">Who can access your data</h2>
		<p class="mt-2">
			Your account data and photos are not shown to other users. The operator can access stored
			information to run, support and secure the service. Infrastructure providers can process data
			as part of hosting, storage and traffic delivery.
		</p>
		<ul class="mt-2 list-disc space-y-2 pl-5">
			<li>
				Akamai Cloud (Linode) hosts the app, database, private photos and encrypted off-host
				backups.
			</li>
			<li>Cloudflare carries public app and agent traffic through its network and tunnel.</li>
			<li>OpenRouter and its model providers process the photo and AI inputs described above.</li>
			<li>An agent service receives the data you authorize it to request.</li>
		</ul>
		<p class="mt-2">
			DocLifts does not run advertising or sell your workout data. We may need to disclose
			information to respond to a valid legal requirement or protect the service and its users.
		</p>
	</section>
	<section aria-labelledby="agents">
		<h2 id="agents" class="text-xl font-semibold text-zinc-100">Connected agents</h2>
		<p class="mt-2">
			Connecting an agent is optional. Check the app name and destination on the consent screen;
			self-registered apps are unverified. Scopes control which workouts, imported history, programs
			and equipment an agent can read. The separate notes permission can include sensitive free-text
			notes; excluding dedicated pain records does not remove health details from notes.
		</p>
		<p class="mt-2">
			You can revoke access in Account → Connected agents. Revocation stops future access using that
			connection. It cannot recall information an agent already copied, and that service’s own
			privacy and retention rules apply.
		</p>
	</section>
	<section aria-labelledby="browser">
		<h2 id="browser" class="text-xl font-semibold text-zinc-100">Cookies and this browser</h2>
		<p class="mt-2">
			Essential cookies keep you signed in and support authentication. Browser storage remembers
			workout layouts, optional fields, timer preferences and some editor drafts. These choices can
			differ between devices. Sign out on shared devices, and clear site data if you also want to
			remove locally remembered preferences or drafts. Clearing browser storage does not delete your
			server account.
		</p>
	</section>
	<section aria-labelledby="retention">
		<h2 id="retention" class="text-xl font-semibold text-zinc-100">
			Retention, removal and export requests
		</h2>
		<p class="mt-2">
			{#if data.deletionEnabled}Account has an explicit, password-confirmed deletion control. Saved
				photos can be removed from their review page, including confirmed photos, while keeping
				logged workout performance.{:else}Self-service account and saved-photo removal are awaiting
				operational activation. Contact support to request deletion.{/if}
			Full data export remains unfinished. Workout Trash affects workouts, not the whole account or every
			associated photo.
		</p>
		<p class="mt-2">
			Account and training data are kept while the service holds your account. Logs, screening and
			model-call records, and discarded-photo records do not yet have automatic age-based deletion.
			We are still implementing retention controls; we do not promise an automatic deletion
			deadline.
		</p>
		<p class="mt-2">
			Encrypted backups contain copies of account data and photos. The current schedule keeps daily,
			weekly and monthly restore points, plus at least the last three complete snapshots. Deleted
			live data can remain in those backups until snapshots expire; provider copies and data already
			shared with agents are separate. A recovery must account for later deletion requests before
			restored data is put back into use.
		</p>
		<p class="mt-2">
			For access, correction, export or deletion requests, contact <a
				href="mailto:support@runthe.ai"
				class="text-indigo-300 underline">support@runthe.ai</a
			>. We may need to verify your account before acting and will explain what can be removed or
			provided and any remaining copies. Do not email passwords or unnecessary sensitive details.
		</p>
	</section>
	<section aria-labelledby="contact">
		<h2 id="contact" class="text-xl font-semibold text-zinc-100">Questions or concerns</h2>
		<p class="mt-2">
			Contact <a href="mailto:support@runthe.ai" class="text-indigo-300 underline"
				>support@runthe.ai</a
			> to report a privacy concern or problem with an upload. We will update this notice as the service
			changes. Material changes to photo processing will require a new acknowledgment before further uploads.
			Alpha access remains operator-managed.
		</p>
	</section>
</main>
