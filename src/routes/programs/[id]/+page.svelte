<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="mx-auto max-w-md p-4">
  <a href="/" class="text-sm text-blue-600 active:underline">← Programs</a>

  <h1 class="mt-2 text-2xl font-semibold">{data.program.name}</h1>
  {#if data.program.description}
    <p class="mt-1 text-sm text-gray-600">{data.program.description}</p>
  {/if}

  <h2 class="mt-6 mb-2 text-lg font-medium">Days</h2>

  {#if data.days.length === 0}
    <p class="text-gray-500">No days configured.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.days as day (day.id)}
        <li class="rounded border border-gray-200 p-3">
          <div class="flex items-baseline justify-between gap-2">
            <div class="font-medium">{day.name}</div>
            {#if day.alternateGroupId}
              <span class="text-xs text-gray-500">alt: {day.alternateGroupId}</span>
            {/if}
          </div>
          {#if day.notes}
            <div class="mt-1 text-xs text-gray-600">{day.notes}</div>
          {/if}

          <div class="mt-3">
            {#if day.openSessionId}
              <a
                href="/sessions/{day.openSessionId}"
                class="inline-block rounded bg-amber-500 px-4 py-2 text-sm font-medium text-white active:bg-amber-600"
              >
                Resume
              </a>
            {:else}
              <form method="POST" action="?/startSession">
                <input type="hidden" name="dayId" value={day.id} />
                <button
                  type="submit"
                  class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white active:bg-blue-700"
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
