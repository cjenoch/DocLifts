<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="mx-auto max-w-md p-4">
  <h1 class="mb-4 text-2xl font-semibold">Programs</h1>

  {#if data.programs.length === 0}
    <p class="text-gray-500">No active programs.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.programs as program (program.id)}
        <li>
          <a
            href="/programs/{program.id}"
            class="block rounded border border-gray-200 p-3 active:bg-gray-100"
          >
            <div class="font-medium">{program.name}</div>
            {#if program.description}
              <div class="mt-1 text-sm text-gray-600">{program.description}</div>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
