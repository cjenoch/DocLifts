import { error } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import {
  db,
  dayExercises,
  days,
  exercises,
  sessions,
  sets,
} from '$lib/server/db';
import { getLastCompletedSet, type HistoryRow } from '$lib/server/progression';
import type { PageServerLoad } from './$types';

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
