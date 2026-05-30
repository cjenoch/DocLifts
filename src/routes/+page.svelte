<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="mx-auto max-w-md px-4 py-6">
  <div class="mb-5 flex items-center justify-between gap-2">
    <h1 class="text-2xl font-semibold tracking-tight">Programs</h1>
    <a
      href="/reports"
      class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-200 active:bg-zinc-800"
    >
      Reporting
    </a>
  </div>

  {#if data.programs.length === 0}
    <p class="text-zinc-500">No active programs.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.programs as program (program.id)}
        <li>
          <a
            href="/programs/{program.id}"
            class="block rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition active:scale-[0.99] active:bg-zinc-900"
          >
            <div class="font-medium text-zinc-100">{program.name}</div>
            {#if program.description}
              <div class="mt-1 text-sm text-zinc-400">{program.description}</div>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
