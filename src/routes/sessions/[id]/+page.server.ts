import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  dayExercises,
  days,
  exercises,
  sessions,
  sets,
} from '$lib/server/db';
import { getLastCompletedSet, type HistoryRow } from '$lib/server/progression';
import type { Actions, PageServerLoad } from './$types';

// Empty string / null / undefined → null. Otherwise parse, pass through
// unparseable values for Zod to flag with "Expected number" rather than NaN.
const optionalNumber = (numSchema: z.ZodNumber) =>
  z.preprocess((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t === '') return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : v;
    }
    return v;
  }, numSchema.nullable());

const updateSetSchema = z.object({
  executedLoad: optionalNumber(z.number().nonnegative()),
  executedReps: optionalNumber(z.number().int().nonnegative()),
  executedRir: optionalNumber(z.number().int().min(0).max(10)),
  notes: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return null;
      const t = v.trim();
      return t === '' ? null : t;
    },
    z.string().nullable(),
  ),
});

export const load: PageServerLoad = async ({ params }) => {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, params.id))
    .limit(1);
  if (!session) {
    error(404, 'Session not found');
  }

  const [day] = await db
    .select()
    .from(days)
    .where(eq(days.id, session.dayId))
    .limit(1);
  if (!day) {
    // Defensive: FK guarantees existence.
    error(500, 'Day missing for session');
  }

  // Day's exercise ordering + tier (for grouping + display).
  const dayExs = await db
    .select({
      exerciseId: dayExercises.exerciseId,
      position: dayExercises.position,
      tier: dayExercises.tier,
      progressionPolicy: dayExercises.progressionPolicy,
    })
    .from(dayExercises)
    .where(eq(dayExercises.dayId, day.id))
    .orderBy(asc(dayExercises.position));

  const exerciseMeta = new Map(
    dayExs.map((de) => [
      de.exerciseId,
      {
        position: de.position,
        tier: de.tier,
        progressionPolicy: de.progressionPolicy,
      },
    ]),
  );

  const sessionSets = await db
    .select({
      id: sets.id,
      exerciseId: sets.exerciseId,
      exerciseName: exercises.name,
      position: sets.position,
      setRole: sets.setRole,
      targetMetric: sets.targetMetric,
      prescribedLoad: sets.prescribedLoad,
      prescribedRepsMin: sets.prescribedRepsMin,
      prescribedRepsMax: sets.prescribedRepsMax,
      prescribedRir: sets.prescribedRir,
      executedLoad: sets.executedLoad,
      executedReps: sets.executedReps,
      executedRir: sets.executedRir,
      notes: sets.notes,
    })
    .from(sets)
    .innerJoin(exercises, eq(sets.exerciseId, exercises.id))
    .where(eq(sets.sessionId, session.id))
    .orderBy(asc(sets.position));

  // Per-set history for inline display. N+1 by design (MVP).
  const histories = await Promise.all(
    sessionSets.map((s) =>
      getLastCompletedSet(db, s.exerciseId, s.setRole, s.position),
    ),
  );

  type SetRow = (typeof sessionSets)[number] & { history: HistoryRow | null };
  type Group = {
    exerciseId: string;
    exerciseName: string;
    tier: 'main' | 'secondary' | 'isolation' | null;
    progressionPolicy: 'standard' | 'cautious' | 'hold' | null;
    sets: SetRow[];
  };

  const groupMap = new Map<string, Group>();
  sessionSets.forEach((s, i) => {
    let g = groupMap.get(s.exerciseId);
    if (!g) {
      const meta = exerciseMeta.get(s.exerciseId);
      g = {
        exerciseId: s.exerciseId,
        exerciseName: s.exerciseName,
        tier: meta?.tier ?? null,
        progressionPolicy: meta?.progressionPolicy ?? null,
        sets: [],
      };
      groupMap.set(s.exerciseId, g);
    }
    g.sets.push({ ...s, history: histories[i] });
  });

  const groups = [...groupMap.values()].sort(
    (a, b) =>
      (exerciseMeta.get(a.exerciseId)?.position ?? 0) -
      (exerciseMeta.get(b.exerciseId)?.position ?? 0),
  );
  for (const g of groups) g.sets.sort((a, b) => a.position - b.position);

  return { session, day, groups };
};

export const actions: Actions = {
  // Idempotent: only stamps endedAt if currently null. Redirects either way,
  // so a stale second submit still lands on /.
  endSession: async ({ params }) => {
    await db
      .update(sessions)
      .set({ endedAt: new Date() })
      .where(and(eq(sessions.id, params.id), isNull(sessions.endedAt)));
    redirect(303, '/');
  },

  // One-row save. Plain HTML form; no client JS required.
  // Returns `{ setId }` on success so the rerender can scope per-row error
  // / saved-state display.
  updateSet: async ({ request, params }) => {
    const form = await request.formData();
    const setId = form.get('setId');
    if (typeof setId !== 'string' || setId.length === 0) {
      return fail(400, { setId: null, message: 'Missing setId' });
    }

    // Guard: a stale tab from an already-ended session must not mutate
    // historical executed values. Keeps history append-only in practice.
    const [session] = await db
      .select({ endedAt: sessions.endedAt })
      .from(sessions)
      .where(eq(sessions.id, params.id))
      .limit(1);
    if (!session) return fail(404, { setId, message: 'Session not found' });
    if (session.endedAt) {
      return fail(409, { setId, message: 'Session has ended' });
    }

    const parsed = updateSetSchema.safeParse({
      executedLoad: form.get('executedLoad'),
      executedReps: form.get('executedReps'),
      executedRir: form.get('executedRir'),
      notes: form.get('notes'),
    });
    if (!parsed.success) {
      return fail(400, {
        setId,
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }

    // Session-scoped WHERE: a hand-crafted POST cannot reach sets from
    // other sessions.
    await db
      .update(sets)
      .set({
        executedLoad: parsed.data.executedLoad,
        executedReps: parsed.data.executedReps,
        executedRir: parsed.data.executedRir,
        notes: parsed.data.notes,
      })
      .where(and(eq(sets.id, setId), eq(sets.sessionId, params.id)));

    return { setId, saved: true };
  },
};
