<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="mx-auto max-w-md px-4 py-6">
  <a href="/" class="text-sm text-indigo-400 active:underline">← Programs</a>

  <h1 class="mt-2 text-2xl font-semibold tracking-tight">{data.program.name}</h1>
  {#if data.program.description}
    <p class="mt-1 text-sm text-zinc-400">{data.program.description}</p>
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
              <form method="POST" action="?/startSession">
                <input type="hidden" name="dayId" value={day.id} />
                <button
                  type="submit"
                  class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-500/20 transition active:scale-[0.98] active:bg-indigo-600"
                >
                  Start
                </button>
              </form>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
