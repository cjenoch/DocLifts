<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Per-day flag: one day's in-flight start must not disable other days' buttons.
  let starting = $state<Record<string, boolean>>({});
</script>

<div class="mx-auto max-w-md px-4 py-6">
  <a href="/" class="text-sm text-indigo-400 active:underline">← Programs</a>

  <h1 class="mt-2 text-2xl font-semibold tracking-tight">{data.program.name}</h1>
  {#if data.program.description}
    <p class="mt-1 text-sm text-zinc-400">{data.program.description}</p>
  {/if}

  <h2 class="mt-7 mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Recent Workouts</h2>

  {#if data.recentSessions.length === 0}
    <p class="text-zinc-500">No recent sessions yet.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.recentSessions as session (session.id)}
        <li class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="font-medium text-zinc-100">{session.dayName}</div>
              <div class="text-xs text-zinc-500">
                {new Date(session.startedAt).toLocaleString()}
                {#if session.endedAt}
                  · ended
                {:else}
                  · open
                {/if}
              </div>
            </div>
            <a
              href="/sessions/{session.id}{session.endedAt ? '?edit=1' : ''}"
              class="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-100 active:bg-zinc-700"
            >
              {session.endedAt ? 'Edit' : 'Resume'}
            </a>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <h2 class="mt-7 mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Days</h2>

  {#if data.days.length === 0}
    <p class="text-zinc-500">No days configured.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.days as day (day.id)}
        <li class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div class="flex items-baseline justify-between gap-2">
            <div class="font-medium text-zinc-100">{day.name}</div>
            {#if day.alternateGroupId}
              <span class="text-xs text-zinc-500">alt: {day.alternateGroupId}</span>
            {/if}
          </div>
          {#if day.notes}
            <div class="mt-1 text-xs text-zinc-400">{day.notes}</div>
          {/if}

          <div class="mt-3">
            {#if day.openSessionId}
              <a
                href="/sessions/{day.openSessionId}"
                class="inline-block rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-zinc-950 shadow-sm shadow-amber-500/20 transition active:scale-[0.98] active:bg-amber-600"
              >
                Resume
              </a>
            {:else}
              <form
                method="POST"
                action="?/startSession"
                use:enhance={({ formData, cancel }) => {
                  const id = String(formData.get('dayId') ?? '');
                  if (starting[id]) {
                    cancel();
                    return;
                  }
                  starting[id] = true;
                  return async ({ update }) => {
                    await update();
                    starting[id] = false;
                  };
                }}
              >
                <input type="hidden" name="dayId" value={day.id} />
                <button
                  type="submit"
                  disabled={starting[day.id]}
                  class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-500/20 transition active:scale-[0.98] active:bg-indigo-600 disabled:opacity-60"
                >
                  {starting[day.id] ? 'Starting…' : 'Start'}
                </button>
              </form>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
