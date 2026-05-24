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
        return { text: 'TOP', cls: 'bg-amber-500 text-zinc-950' };
      case 'warmup':
        return { text: 'warmup', cls: 'bg-zinc-800 text-zinc-400' };
      case 'backoff':
        return { text: 'backoff', cls: 'bg-indigo-500/15 text-indigo-300' };
      default:
        return { text: 'working', cls: 'bg-zinc-800 text-zinc-300' };
    }
  }

  function rowClass(role: Role, logged: boolean): string {
    if (logged) return 'border-l-4 border-emerald-400 bg-emerald-500/10';
    if (role === 'top') return 'border-l-4 border-amber-400 bg-amber-500/10';
    if (role === 'warmup') return 'opacity-70';
    return 'border-l-4 border-zinc-800';
  }
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
    {#if data.session.endedAt}· ended{/if}
  </p>

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
          {@const badge = roleBadge(set.setRole)}
          {@const hist = formatHistory(set.history, set.targetMetric)}
          {@const logged = set.executedLoad != null}
          {@const rowError = form?.setId === set.id ? (form.fieldErrors ?? null) : null}
          {@const rowMessage =
            form?.setId === set.id && 'message' in form ? form.message : null}
          {@const sessionEnded = data.session.endedAt != null}
          <li id="set-{set.id}" class="rounded-lg bg-zinc-900/60 p-3 text-sm {rowClass(set.setRole, logged)}">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="w-5 text-right text-xs text-zinc-500">{set.position}</span>
                <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide {badge.cls}">
                  {badge.text}
                </span>
                {#if logged}
                  <span class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                    logged
                  </span>
                {/if}
              </div>
              <div class="text-right text-xs text-zinc-400">
                <span class="font-mono text-zinc-200">{set.prescribedLoad ?? '—'}</span>
                ×
                <span class="font-mono text-zinc-200">
                  {formatTarget(set.prescribedRepsMin, set.prescribedRepsMax, set.targetMetric)}
                </span>
                {#if set.prescribedRir != null}
                  <span class="ml-1">RIR {set.prescribedRir}</span>
                {/if}
              </div>
            </div>
            {#if hist}
              <div class="pl-9 text-xs text-zinc-500">Last: {hist}</div>
            {/if}

            {#if !sessionEnded}
              <form
                method="POST"
                action="?/updateSet"
                class="mt-2 flex flex-wrap items-center gap-1.5"
              >
                <input type="hidden" name="setId" value={set.id} />
                <label class="flex items-center gap-1">
                  <span class="text-[10px] uppercase tracking-wide text-zinc-500">load</span>
                  <input
                    type="number"
                    name="executedLoad"
                    inputmode="decimal"
                    step="0.5"
                    min="0"
                    value={set.executedLoad ?? set.prescribedLoad ?? ''}
                    class="w-16 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 tabular-nums"
                  />
                </label>
                <label class="flex items-center gap-1">
                  <span class="text-[10px] uppercase tracking-wide text-zinc-500">
                    {set.targetMetric === 'seconds' ? 'sec' : 'reps'}
                  </span>
                  <input
                    type="number"
                    name="executedReps"
                    inputmode="numeric"
                    step="1"
                    min="0"
                    value={set.executedReps ?? ''}
                    class="w-14 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 tabular-nums"
                  />
                </label>
                <label class="flex items-center gap-1">
                  <span class="text-[10px] uppercase tracking-wide text-zinc-500">RIR</span>
                  <input
                    type="number"
                    name="executedRir"
                    inputmode="numeric"
                    step="1"
                    min="0"
                    max="10"
                    value={set.executedRir ?? ''}
                    class="w-12 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 tabular-nums"
                  />
                </label>
                <button
                  type="submit"
                  class="ml-auto rounded-md bg-indigo-500 px-3 py-1 text-xs font-semibold text-white shadow-sm shadow-indigo-500/20 transition active:scale-[0.97] active:bg-indigo-600"
                >
                  Save
                </button>
                <input
                  type="text"
                  name="notes"
                  placeholder="notes"
                  value={set.notes ?? ''}
                  class="basis-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1"
                />
                {#if rowError}
                  <div class="basis-full text-xs text-rose-400">
                    {#each Object.entries(rowError) as [field, msgs]}
                      <span class="mr-2">{field}: {msgs?.[0]}</span>
                    {/each}
                  </div>
                {/if}
                {#if rowMessage}
                  <div class="basis-full text-xs text-rose-400">{rowMessage}</div>
                {/if}
              </form>
            {:else if logged}
              <div class="mt-1 pl-9 text-xs text-zinc-300">
                Executed
                <span class="font-mono text-zinc-100">{set.executedLoad ?? '—'}</span>
                ×
                <span class="font-mono text-zinc-100">{set.executedReps ?? '—'}</span>
                {#if set.executedRir != null}
                  @ RIR {set.executedRir}
                {/if}
                {#if set.notes}
                  <div class="italic text-zinc-500">{set.notes}</div>
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
    class="sticky bottom-0 border-t border-zinc-800 bg-zinc-950/90 p-4 backdrop-blur"
  >
    <div class="mx-auto max-w-md">
      <button
        type="submit"
        class="w-full rounded-lg bg-emerald-500 px-4 py-3 text-base font-semibold text-zinc-950 shadow-sm shadow-emerald-500/20 transition active:scale-[0.99] active:bg-emerald-600"
      >
        End Session
      </button>
    </div>
  </form>
{/if}
