<script lang="ts">
  import type { ActionData, PageData } from './$types';
  import SetRow from './SetRow.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="mx-auto max-w-md px-4 py-6 pb-28">
  <a
    href="/programs/{data.session.programId}"
    class="text-sm text-indigo-400 active:underline"
  >
    ← Back
  </a>

  <h1 class="mt-2 text-xl font-semibold tracking-tight">{data.day.name}</h1>
  <p class="text-xs text-zinc-500">
    Started {new Date(data.session.startedAt).toLocaleString()}
    {#if data.session.endedAt}
      · ended {new Date(data.session.endedAt).toLocaleString()}
    {/if}
  </p>

  {#if data.session.endedAt}
    <div class="mt-2 flex items-center gap-2 text-xs">
      {#if data.allowEndedSessionEdit}
        <span class="rounded bg-amber-500/20 px-2 py-1 text-amber-300">Editing ended session</span>
        <a href="/sessions/{data.session.id}" class="text-indigo-400 active:underline">Done editing</a>
      {:else}
        <span class="text-zinc-400">This session is read-only.</span>
        <a href="/sessions/{data.session.id}?edit=1" class="text-indigo-400 active:underline">
          Edit this workout
        </a>
      {/if}
    </div>
  {/if}

  {#each data.groups as group (group.exerciseId)}
    <section class="mt-7">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="text-base font-semibold text-zinc-100">{group.exerciseName}</h2>
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
          {#if group.tier}
            <span>{group.tier}</span>
          {/if}
          {#if group.progressionPolicy && group.progressionPolicy !== 'standard'}
            <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
              {group.progressionPolicy}
            </span>
          {/if}
        </div>
      </div>

      <ul class="mt-2 space-y-2">
        {#each group.sets as set (set.id)}
          <SetRow
            {set}
            sessionEnded={data.session.endedAt != null}
            allowEndedSessionEdit={data.allowEndedSessionEdit}
            rowError={form?.setId === set.id ? (form.fieldErrors ?? null) : null}
            rowMessage={form?.setId === set.id && 'message' in form ? (form.message ?? null) : null}
          />
        {/each}
      </ul>
    </section>
  {/each}
</div>

{#if !data.session.endedAt}
  <div class="sticky bottom-0 border-t border-zinc-800 bg-zinc-950/90 p-4 backdrop-blur">
    <div class="mx-auto grid max-w-md grid-cols-2 gap-2">
      <a
        href="/programs/{data.session.programId}"
        class="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-center text-sm font-semibold text-zinc-200 transition active:scale-[0.99] active:bg-zinc-800"
      >
        Pause Session
      </a>
      <form method="POST" action="?/endSession">
        <button
          type="submit"
          class="w-full rounded-lg bg-emerald-500 px-4 py-3 text-base font-semibold text-zinc-950 shadow-sm shadow-emerald-500/20 transition active:scale-[0.99] active:bg-emerald-600"
        >
          End Session
        </button>
      </form>
    </div>
  </div>
{/if}
