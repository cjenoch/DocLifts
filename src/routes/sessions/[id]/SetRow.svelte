<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import type { PageData } from './$types';

  type SetRow = PageData['groups'][number]['sets'][number];
  type Metric = SetRow['targetMetric'];
  type Role = SetRow['setRole'];

  let {
    set,
    sessionEnded,
    allowEndedSessionEdit,
    rowError,
    rowMessage,
  }: {
    set: SetRow;
    sessionEnded: boolean;
    allowEndedSessionEdit: boolean;
    rowError: Record<string, string[] | undefined> | null;
    rowMessage: string | null;
  } = $props();

  // Local input state, captured ONCE at mount via untrack(). Living in this
  // component (preserved across the parent's re-renders by the keyed each
  // block) means typing-but-not-saving a value here doesn't get wiped when
  // another row saves. After a successful save of THIS row, these values
  // already equal what was just persisted, so no re-sync needed.
  let executedLoad = $state<string>(
    untrack(() =>
      set.executedLoad != null
        ? String(set.executedLoad)
        : set.prescribedLoad != null
          ? String(set.prescribedLoad)
          : '',
    ),
  );
  let executedReps = $state<string>(
    untrack(() => (set.executedReps != null ? String(set.executedReps) : '')),
  );
  let executedRir = $state<string>(
    untrack(() => (set.executedRir != null ? String(set.executedRir) : '')),
  );
  let notes = $state<string>(untrack(() => set.notes ?? ''));

  const logged = $derived(set.executedLoad != null);

  function formatTarget(min: number | null, max: number | null, metric: Metric): string {
    if (min == null && max == null) return '—';
    const unit = metric === 'seconds' ? 's' : '';
    if (min === max) return `${min}${unit}`;
    return `${min}-${max}${unit}`;
  }

  function formatHistory(h: SetRow['history'], metric: Metric): string | null {
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

  function rowClass(role: Role, isLogged: boolean): string {
    if (isLogged) return 'border-l-4 border-emerald-400 bg-emerald-500/10';
    if (role === 'top') return 'border-l-4 border-amber-400 bg-amber-500/10';
    if (role === 'warmup') return 'opacity-70';
    return 'border-l-4 border-zinc-800';
  }

  const badge = $derived(roleBadge(set.setRole));
  const hist = $derived(formatHistory(set.history, set.targetMetric));
</script>

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

  {#if !sessionEnded || allowEndedSessionEdit}
    <form method="POST" action="?/updateSet" use:enhance class="mt-2 flex flex-wrap items-center gap-1.5">
      {#if allowEndedSessionEdit}
        <input type="hidden" name="allowEndedSessionEdit" value="1" />
      {/if}
      <input type="hidden" name="setId" value={set.id} />
      <label class="flex items-center gap-1">
        <span class="text-[10px] uppercase tracking-wide text-zinc-500">load</span>
        <input
          type="number"
          name="executedLoad"
          inputmode="decimal"
          step="0.5"
          min="0"
          bind:value={executedLoad}
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
          bind:value={executedReps}
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
          bind:value={executedRir}
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
        bind:value={notes}
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
