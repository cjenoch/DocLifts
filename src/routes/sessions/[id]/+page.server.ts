import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  db,
  dayExercises,
  days,
  exercises,
  sessions,
  sets,
} from '$lib/server/db';
import { getLastCompletedSet, type HistoryRow } from '$lib/server/progression';
import {
  endSession,
  nextSetIdInSession,
  updateSetInSession,
} from '$lib/server/sessions';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, params.id), isNull(sessions.deletedAt)))
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
  // Exclude THIS session — once it ends, its own set would otherwise become
  // "the most recent completed" and the "Last: …" line would duplicate the
  // executed value shown right above it in the same row.
  const histories = await Promise.all(
    sessionSets.map((s) =>
      getLastCompletedSet(db, s.exerciseId, s.setRole, s.position, session.id),
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

  const allowEndedSessionEdit =
    session.endedAt != null && url.searchParams.get('edit') === '1';

  return { session, day, groups, allowEndedSessionEdit };
};

const reopenEndedSessionSchema = z.object({
  allowEndedSessionEdit: z.literal('1'),
});

const deleteEndedSessionSchema = z.object({
  confirmDelete: z.preprocess(
    (v) => (typeof v === 'string' ? v.toLowerCase() : v),
    z.literal('d')
  ),
});

export const actions: Actions = {
  endSession: async ({ params }) => {
    await endSession(db, params.id);
    redirect(303, '/');
  },

  updateSet: async ({ request, params }) => {
    const form = await request.formData();
    const setId = form.get('setId');
    if (typeof setId !== 'string' || setId.length === 0) {
      return fail(400, { setId: null, message: 'Missing setId' });
    }

    const allowEndedSessionEditRaw = form.get('allowEndedSessionEdit');
    const allowEndedSessionEdit = reopenEndedSessionSchema.safeParse({
      allowEndedSessionEdit: allowEndedSessionEditRaw,
    }).success;

    const result = await updateSetInSession(
      db,
      params.id,
      setId,
      {
        executedLoad: form.get('executedLoad'),
        executedReps: form.get('executedReps'),
        executedRir: form.get('executedRir'),
        notes: form.get('notes'),
      },
      { allowEndedSession: allowEndedSessionEdit }
    );

    if (!result.ok) {
      return fail(result.status, {
        setId: result.setId,
        ...(result.message !== undefined && { message: result.message }),
        ...(result.fieldErrors !== undefined && {
          fieldErrors: result.fieldErrors,
        }),
      });
    }

    // Redirect to the same page with a fragment anchoring the NEXT row,
    // so saving scrolls the user toward what they're about to log instead
    // of resetting to top. Falls back to the just-saved row when there's
    // no next set (last row of the session). Browser-native scroll-to-
    // anchor; no client JS required.
    const nextId = await nextSetIdInSession(db, params.id, result.setId);
    redirect(303, `/sessions/${params.id}#set-${nextId ?? result.setId}`);
  },

  deleteSession: async ({ request, params }) => {
    const [session] = await db
      .select({ id: sessions.id, programId: sessions.programId, endedAt: sessions.endedAt })
      .from(sessions)
      .where(and(eq(sessions.id, params.id), isNull(sessions.deletedAt)))
      .limit(1);

    if (!session) {
      return fail(404, { message: 'Session not found' });
    }
    if (!session.endedAt) {
      return fail(409, { message: 'Only ended sessions can be deleted from this page' });
    }

    const form = await request.formData();
    const parsed = deleteEndedSessionSchema.safeParse({
      confirmDelete: form.get('confirmDelete'),
    });
    if (!parsed.success) {
      return fail(400, { message: 'Press d in the delete box to confirm' });
    }

    await db
      .update(sessions)
      .set({ deletedAt: new Date() })
      .where(and(eq(sessions.id, session.id), isNull(sessions.deletedAt), isNotNull(sessions.endedAt)));

    redirect(303, `/programs/${session.programId}`);
  },
};
