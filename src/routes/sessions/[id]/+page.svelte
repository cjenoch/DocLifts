<script lang="ts">
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Metric = 'reps' | 'seconds';
  type Role = 'warmup' | 'working' | 'top' | 'backoff';

  function formatTarget(
    min: number | null,
    max: number | null,
    metric: Metric,
  ): string {
    if (min == null && max == null) return '—';
    const unit = metric === 'seconds' ? 's' : '';
    if (min === max) return `${min}${unit}`;
    return `${min}-${max}${unit}`;
  }

  function formatHistory(
    h: PageData['groups'][number]['sets'][number]['history'],
    metric: Metric,
  ): string | null {
    if (!h || h.executedLoad == null || h.executedReps == null) return null;
    const unit = metric === 'seconds' ? 's' : '';
    let s = `${h.executedLoad} × ${h.executedReps}${unit}`;
    if (h.executedRir != null) s += ` @ RIR ${h.executedRir}`;
    return s;
  }

  function roleBadge(role: Role): { text: string; cls: string } {
    switch (role) {
      case 'top':
        return { text: 'TOP', cls: 'bg-amber-500 text-white' };
      case 'warmup':
        return { text: 'warmup', cls: 'bg-gray-200 text-gray-700' };
      case 'backoff':
        return { text: 'backoff', cls: 'bg-blue-100 text-blue-800' };
      default:
        return { text: 'working', cls: 'bg-gray-100 text-gray-700' };
    }
  }

  function rowClass(role: Role, logged: boolean): string {
    if (logged) return 'border-l-4 border-green-500 bg-green-50';
    if (role === 'top') return 'border-l-4 border-amber-500 bg-amber-50';
    if (role === 'warmup') return 'opacity-80';
    return '';
  }
</script>

<div class="mx-auto max-w-md p-4 pb-24">
  <a
    href="/programs/{data.session.programId}"
    class="text-sm text-blue-600 active:underline"
  >
    ← Back
  </a>

  <h1 class="mt-2 text-xl font-semibold">{data.day.name}</h1>
  <p class="text-xs text-gray-500">
    Started {new Date(data.session.startedAt).toLocaleString()}
    {#if data.session.endedAt}· ended{/if}
  </p>

  {#each data.groups as group (group.exerciseId)}
    <section class="mt-6">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="text-base font-semibold">{group.exerciseName}</h2>
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-500">
          {#if group.tier}
            <span>{group.tier}</span>
          {/if}
          {#if group.progressionPolicy && group.progressionPolicy !== 'standard'}
            <span class="rounded bg-gray-200 px-1 text-gray-700">
              {group.progressionPolicy}
            </span>
          {/if}
        </div>
      </div>

      <ul class="mt-2 space-y-2">
        {#each group.sets as set (set.id)}
          {@const badge = roleBadge(set.setRole)}
          {@const hist = formatHistory(set.history, set.targetMetric)}
          {@const logged = set.executedLoad != null}
          {@const rowError = form?.setId === set.id ? (form.fieldErrors ?? null) : null}
          {@const rowMessage =
            form?.setId === set.id && 'message' in form ? form.message : null}
          {@const sessionEnded = data.session.endedAt != null}
          <li class="rounded p-2 text-sm {rowClass(set.setRole, logged)}">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="w-5 text-right text-xs text-gray-500">{set.position}</span>
                <span class="rounded px-1.5 py-0.5 text-[10px] font-medium {badge.cls}">
                  {badge.text}
                </span>
                {#if logged}
                  <span class="rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    logged
                  </span>
                {/if}
              </div>
              <div class="text-right text-xs text-gray-600">
                <span class="font-mono">{set.prescribedLoad ?? '—'}</span>
                ×
                <span class="font-mono">
                  {formatTarget(set.prescribedRepsMin, set.prescribedRepsMax, set.targetMetric)}
                </span>
                {#if set.prescribedRir != null}
                  <span class="ml-1">RIR {set.prescribedRir}</span>
                {/if}
              </div>
            </div>
            {#if hist}
              <div class="pl-9 text-xs text-gray-500">Last: {hist}</div>
            {/if}

            {#if !sessionEnded}
              <form
                method="POST"
                action="?/updateSet"
                class="mt-2 flex flex-wrap items-center gap-1.5"
              >
                <input type="hidden" name="setId" value={set.id} />
                <label class="flex items-center gap-1">
                  <span class="text-[10px] text-gray-500">load</span>
                  <input
                    type="number"
                    name="executedLoad"
                    inputmode="decimal"
                    step="0.5"
                    min="0"
                    value={set.executedLoad ?? set.prescribedLoad ?? ''}
                    class="w-16 rounded border border-gray-300 px-1.5 py-1 text-sm tabular-nums"
                  />
                </label>
                <label class="flex items-center gap-1">
                  <span class="text-[10px] text-gray-500">
                    {set.targetMetric === 'seconds' ? 'sec' : 'reps'}
                  </span>
                  <input
                    type="number"
                    name="executedReps"
                    inputmode="numeric"
                    step="1"
                    min="0"
                    value={set.executedReps ?? ''}
                    class="w-14 rounded border border-gray-300 px-1.5 py-1 text-sm tabular-nums"
                  />
                </label>
                <label class="flex items-center gap-1">
                  <span class="text-[10px] text-gray-500">RIR</span>
                  <input
                    type="number"
                    name="executedRir"
                    inputmode="numeric"
                    step="1"
                    min="0"
                    max="10"
                    value={set.executedRir ?? ''}
                    class="w-12 rounded border border-gray-300 px-1.5 py-1 text-sm tabular-nums"
                  />
                </label>
                <button
                  type="submit"
                  class="ml-auto rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white active:bg-blue-700"
                >
                  Save
                </button>
                <input
                  type="text"
                  name="notes"
                  placeholder="notes"
                  value={set.notes ?? ''}
                  class="basis-full rounded border border-gray-200 px-2 py-1 text-xs"
                />
                {#if rowError}
                  <div class="basis-full text-xs text-red-600">
                    {#each Object.entries(rowError) as [field, msgs]}
                      <span class="mr-2">{field}: {msgs?.[0]}</span>
                    {/each}
                  </div>
                {/if}
                {#if rowMessage}
                  <div class="basis-full text-xs text-red-600">{rowMessage}</div>
                {/if}
              </form>
            {:else if logged}
              <div class="mt-1 pl-9 text-xs text-gray-700">
                Executed
                <span class="font-mono">{set.executedLoad ?? '—'}</span>
                ×
                <span class="font-mono">{set.executedReps ?? '—'}</span>
                {#if set.executedRir != null}
                  @ RIR {set.executedRir}
                {/if}
                {#if set.notes}
                  <div class="italic text-gray-500">{set.notes}</div>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

{#if !data.session.endedAt}
  <form
    method="POST"
    action="?/endSession"
    class="sticky bottom-0 border-t border-gray-200 bg-white/95 p-4 backdrop-blur"
  >
    <div class="mx-auto max-w-md">
      <button
        type="submit"
        class="w-full rounded bg-green-600 px-4 py-3 text-base font-semibold text-white active:bg-green-700"
      >
        End Session
      </button>
    </div>
  </form>
{/if}
