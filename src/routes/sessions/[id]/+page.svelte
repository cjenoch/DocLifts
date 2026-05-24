<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

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

  function rowClass(role: Role): string {
    if (role === 'top') return 'border-l-4 border-amber-500 bg-amber-50';
    if (role === 'warmup') return 'opacity-70';
    return '';
  }
</script>

<div class="mx-auto max-w-md p-4 pb-8">
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
            <span class="rounded bg-gray-200 px-1 text-gray-700">{group.progressionPolicy}</span>
          {/if}
        </div>
      </div>

      <ul class="mt-2 space-y-1">
        {#each group.sets as set (set.id)}
          {@const badge = roleBadge(set.setRole)}
          {@const hist = formatHistory(set.history, set.targetMetric)}
          <li class="flex flex-col gap-1 rounded p-2 text-sm {rowClass(set.setRole)}">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="w-5 text-right text-xs text-gray-500">{set.position}</span>
                <span class="rounded px-1.5 py-0.5 text-[10px] font-medium {badge.cls}">
                  {badge.text}
                </span>
              </div>
              <div class="text-right">
                <span class="font-mono">{set.prescribedLoad ?? '—'}</span>
                ×
                <span class="font-mono">
                  {formatTarget(set.prescribedRepsMin, set.prescribedRepsMax, set.targetMetric)}
                </span>
                {#if set.prescribedRir != null}
                  <span class="ml-1 text-xs text-gray-500">RIR {set.prescribedRir}</span>
                {/if}
              </div>
            </div>
            {#if hist}
              <div class="pl-9 text-xs text-gray-500">Last: {hist}</div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
