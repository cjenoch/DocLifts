<script lang="ts">
	import { onMount } from 'svelte';
	import { workoutUi as ui } from '$lib/workout-ui';
	let { sessionId, userId }: { sessionId: string; userId: string } = $props();
	type Rest = { startedAt: number; seconds: number };
	let rest = $state<Rest | null>(null),
		now = $state(Date.now()),
		settings = $state(false);
	let duration = $state(ui.defaultRestSeconds),
		sound = $state(false),
		visual = $state('pulse');
	let alertCount = $state(0),
		status = $state(''),
		audio: AudioContext | undefined;
	let alerted = false;
	const restKey = $derived(`doclifts:rest:${sessionId}`);
	const prefKey = $derived(`doclifts:timer:${userId}`);
	const left = $derived(
		rest ? Math.max(0, rest.seconds - Math.floor((now - rest.startedAt) / 1000)) : duration
	);
	const clock = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
	function keep(next: Rest | null) {
		rest = next;
		now = Date.now();
		alerted = false;
		try {
			if (next) localStorage.setItem(restKey, JSON.stringify(next));
			else localStorage.removeItem(restKey);
		} catch {
			/* Timer remains available in memory. */
		}
	}
	function remember() {
		try {
			localStorage.setItem(prefKey, JSON.stringify({ duration, sound, visual }));
		} catch {
			status = 'Settings work here but cannot be remembered by this browser.';
		}
	}
	/** Called during a user gesture, before the asynchronous set save. */
	export function prepare() {
		if (!sound) return;
		try {
			audio ??= new AudioContext();
			void audio.resume().catch(() => {
				status = 'Sound is unavailable; visual alerts still work.';
			});
		} catch {
			status = 'Sound is unavailable; visual alerts still work.';
		}
	}
	export function start() {
		if (!ui.restTimerEnabled) return;
		keep({ startedAt: Date.now(), seconds: duration });
		status = '';
	}
	function alert() {
		alertCount += 1;
		status = 'Rest finished · ready for your next set';
		if (!sound) return;
		if (!audio || audio.state !== 'running') {
			status = 'Rest finished · tap the clock to enable sound in this tab';
			return;
		}
		for (const [offset, hz] of [
			[0, 660],
			[0.19, 880]
		]) {
			const osc = audio.createOscillator(),
				gain = audio.createGain(),
				t = audio.currentTime + offset;
			osc.frequency.value = hz;
			gain.gain.setValueAtTime(0, t);
			gain.gain.linearRampToValueAtTime(0.12, t + 0.015);
			gain.gain.exponentialRampToValueAtTime(0.001, t + 0.23);
			osc.connect(gain);
			gain.connect(audio.destination);
			osc.start(t);
			osc.stop(t + 0.25);
			osc.onended = () => {
				osc.disconnect();
				gain.disconnect();
			};
		}
	}
	onMount(() => {
		try {
			const prefs = JSON.parse(localStorage.getItem(prefKey) ?? 'null');
			if ([5, 30, 60, 90, 120, 180, 300].includes(prefs?.duration)) duration = prefs.duration;
			sound = prefs?.sound === true;
			if (['pulse', 'shake', 'none'].includes(prefs?.visual)) visual = prefs.visual;
			const saved = JSON.parse(localStorage.getItem(restKey) ?? 'null');
			if (
				Number.isFinite(saved?.startedAt) &&
				Number.isFinite(saved?.seconds) &&
				saved.seconds > 0 &&
				saved.seconds <= 86400
			) {
				rest = saved;
				alerted = Date.now() >= saved.startedAt + saved.seconds * 1000;
			}
		} catch {
			/* Optional browser storage. */
		}
		const tick = () => {
			now = Date.now();
			if (rest && !alerted && now >= rest.startedAt + rest.seconds * 1000) {
				alerted = true;
				alert();
			}
		};
		const interval = setInterval(tick, 500);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(interval);
			document.removeEventListener('visibilitychange', tick);
			void audio?.close();
		};
	});
</script>

<div class="timer-shell">
	{#key alertCount}<div
			class:pulse={alertCount > 0 && visual === 'pulse'}
			class:shake={alertCount > 0 && visual === 'shake'}
			class="timer-line"
		>
			<button
				type="button"
				class="clock-button"
				aria-label="Timer settings"
				aria-expanded={settings}
				onclick={() => (settings = !settings)}>◷</button
			>
			{#if rest}<div class="running" data-testid="rest-timer">
					<button
						type="button"
						class="readout"
						aria-label={ui.restDismiss}
						onclick={() => keep(null)}
						><span>{left ? ui.restLabel : ui.restOver}</span><output data-testid="rest-clock"
							>{clock(left)}</output
						></button
					><button
						type="button"
						aria-label={ui.restAdd}
						onclick={() => rest && keep({ ...rest, seconds: rest.seconds + ui.restAddSeconds })}
						>{ui.restAdd}</button
					>
				</div>
			{:else}<span class="idle">{clock(duration)}</span><button
					type="button"
					onclick={() => {
						prepare();
						start();
					}}>Start rest</button
				>{/if}
		</div>{/key}
	{#if status}<p role="status">{status}</p>{/if}
</div>
{#if settings}
	<div class="timer-settings" role="region" aria-label="Rest timer settings">
		<div class="heading">
			<h2>Rest timer</h2>
			<button type="button" aria-label="Close timer settings" onclick={() => (settings = false)}
				>Close</button
			>
		</div>
		<label
			>Rest duration<select aria-label="Rest duration" bind:value={duration} onchange={remember}
				>{#each [[5, '5 seconds · test'], [30, '30 seconds'], [60, '1 minute'], [90, '1 min 30 sec'], [120, '2 minutes'], [180, '3 minutes'], [300, '5 minutes']] as const as [value, label]}<option
						{value}>{label}</option
					>{/each}</select
			></label
		>
		<label
			>Play a chime<input
				type="checkbox"
				bind:checked={sound}
				onchange={() => {
					remember();
					prepare();
				}}
			/></label
		>
		<label
			>Visual alert<select aria-label="Visual alert" bind:value={visual} onchange={remember}
				><option value="pulse">Timer pulse</option><option value="shake">Small shake</option><option
					value="none">Text only</option
				></select
			></label
		>
		<p>
			Sound is optional. Keep the app open for reliable alerts. Locked phones and background tabs
			may delay or silence them. Reduced-motion settings disable animation.
		</p>
		<button
			type="button"
			class="preview"
			onclick={() => {
				prepare();
				settings = false;
				setTimeout(alert, 100);
			}}>Try alert</button
		>
	</div>
{/if}

<style>
	.timer-line,
	.running,
	.heading {
		display: flex;
		align-items: center;
		gap: 10px;
		justify-content: space-between;
	}
	.timer-line {
		border-radius: 12px;
	}
	.running {
		flex: 1;
	}
	.clock-button {
		font-size: 28px;
		width: 44px;
		flex-shrink: 0;
	}
	button {
		min-height: 44px;
		padding: 6px 10px;
		color: #d9f0e2;
		border-radius: 10px;
		font-size: 13px;
	}
	.readout {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.readout span {
		font-size: 12px;
		color: #9eada4;
	}
	output,
	.idle {
		font-size: 22px;
		font-variant-numeric: tabular-nums;
		color: #96dbaf;
	}
	p {
		font-size: 12px;
		color: #a5b6aa;
		line-height: 1.5;
		margin: 6px 0;
	}
	.timer-settings {
		position: fixed;
		z-index: 60;
		inset: 12% 12px auto;
		margin: auto;
		max-width: 440px;
		max-height: 75dvh;
		overflow: auto;
		background: #121c16;
		padding: 20px;
		border: 1px solid #3a5142;
		border-radius: 20px;
		box-shadow: 0 0 0 100vmax #000b;
	}
	h2 {
		font-size: 20px;
		font-weight: 600;
	}
	label {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		padding: 14px 0;
		font-size: 14px;
		border-bottom: 1px solid #304034;
	}
	select {
		background: #1d2b22;
		color: #edf6ee;
		border: 1px solid #425447;
		border-radius: 8px;
		padding: 8px;
		min-height: 44px;
		font-size: 16px;
		max-width: 100%;
	}
	input {
		width: 22px;
		height: 22px;
		accent-color: #96dbaf;
	}
	.preview {
		width: 100%;
		background: #25583b;
		margin-top: 12px;
		font-size: 16px;
	}
	.pulse {
		animation: pulse 0.7s ease-in-out 2;
	}
	.shake {
		animation: shake 0.4s ease-in-out 2;
	}
	@keyframes pulse {
		50% {
			box-shadow: 0 0 0 6px #275c3c;
			background: #1c3727;
		}
	}
	@keyframes shake {
		25%,
		75% {
			transform: translateX(-3px);
		}
		50% {
			transform: translateX(3px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse,
		.shake {
			animation: none;
		}
	}
</style>
