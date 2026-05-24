import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  db,
  dayExercises,
  days,
  prescribedSets,
  programs,
  sessions,
  sets,
} from '$lib/server/db';
import { getLastCompletedSet } from '$lib/server/progression';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, params.id))
    .limit(1);

  if (!program) {
    error(404, 'Program not found');
  }

  const programDays = await db
    .select({
      id: days.id,
      name: days.name,
      position: days.position,
      alternateGroupId: days.alternateGroupId,
      notes: days.notes,
    })
    .from(days)
    .where(eq(days.programId, program.id))
    .orderBy(days.position);

  const dayIds = programDays.map((d) => d.id);
  const openSessions = dayIds.length
    ? await db
        .select({ id: sessions.id, dayId: sessions.dayId })
        .from(sessions)
        .where(and(inArray(sessions.dayId, dayIds), isNull(sessions.endedAt)))
    : [];
  const openByDay = new Map(openSessions.map((s) => [s.dayId, s.id]));

  return {
    program,
    days: programDays.map((d) => ({
      ...d,
      openSessionId: openByDay.get(d.id) ?? null,
    })),
  };
};

export const actions: Actions = {
  startSession: async ({ request }) => {
    const form = await request.formData();
    const dayId = form.get('dayId');
    if (typeof dayId !== 'string' || dayId.length === 0) {
      return fail(400, { message: 'Missing dayId' });
    }

    // Derive programId from the day server-side — never trust client form value.
    // (CLAUDE.md: session-start integrity rule.)
    const [day] = await db
      .select({ id: days.id, programId: days.programId })
      .from(days)
      .where(eq(days.id, dayId))
      .limit(1);
    if (!day) {
      return fail(404, { message: 'Day not found' });
    }

    // Pull all prescribed sets for the day, joined to day_exercises for
    // exerciseId + ordering. Ordered by exercise position, then set position.
    const prescribed = await db
      .select({
        prescribedSetId: prescribedSets.id,
        setPosition: prescribedSets.position,
        setRole: prescribedSets.setRole,
        targetMetric: prescribedSets.targetMetric,
        targetRepsMin: prescribedSets.targetRepsMin,
        targetRepsMax: prescribedSets.targetRepsMax,
        targetRir: prescribedSets.targetRir,
        initialLoad: prescribedSets.initialLoad,
        exerciseId: dayExercises.exerciseId,
        exercisePosition: dayExercises.position,
      })
      .from(prescribedSets)
      .innerJoin(
        dayExercises,
        eq(prescribedSets.dayExerciseId, dayExercises.id),
      )
      .where(eq(dayExercises.dayId, day.id))
      .orderBy(asc(dayExercises.position), asc(prescribedSets.position));

    // Dumb prefill per row: history.executedLoad ?? initialLoad.
    // History filter (executedLoad/Reps non-null, session ended) lives inside
    // getLastCompletedSet, per CLAUDE.md history-lookup rule.
    // N+1 by design — single-user localhost Postgres, see handoff notes.
    // Reads kept outside the transaction; the tx only wraps writes so a
    // mid-loop failure can't orphan a session.
    const prefilledLoads = await Promise.all(
      prescribed.map(async (p) => {
        const history = await getLastCompletedSet(
          db,
          p.exerciseId,
          p.setRole,
          p.setPosition,
        );
        return history?.executedLoad ?? p.initialLoad;
      }),
    );

    const sessionId = await db.transaction(async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({
          dayId: day.id,
          programId: day.programId,
        })
        .returning({ id: sessions.id });

      for (let i = 0; i < prescribed.length; i++) {
        const p = prescribed[i];
        await tx.insert(sets).values({
          sessionId: session.id,
          exerciseId: p.exerciseId,
          prescribedSetId: p.prescribedSetId,
          position: p.setPosition,
          setRole: p.setRole,
          targetMetric: p.targetMetric,
          prescribedLoad: prefilledLoads[i],
          prescribedRepsMin: p.targetRepsMin,
          prescribedRepsMax: p.targetRepsMax,
          prescribedRir: p.targetRir,
        });
      }

      return session.id;
    });

    redirect(303, `/sessions/${sessionId}`);
  },
};
