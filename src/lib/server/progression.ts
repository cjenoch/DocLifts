/**
 * Progression engine for the Lift Log app.
 *
 * Place at: src/lib/server/progression.ts
 *
 * Encodes the v5 program's progression rules. Tier-aware: MAIN is top-set-driven;
 * SECONDARY/ISOLATION require ALL relevant sets to clear top of range.
 *
 * CRITICAL PRINCIPLE: This engine produces *suggestions*, never auto-applied.
 * User override is always one tap away. The user's read on form quality
 * outranks engine output.
 *
 * Pipeline order (per planning §16): history → engine (this file) → plate snap → display.
 * The engine produces an ideal raw load. Plate snapping happens AFTER, in plates.ts
 * (via `snapForEquipment`).
 */

import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './db/schema';
import { sessions, sets } from './db/schema';

/**
 * Local type alias for any Drizzle PG client backed by this schema.
 * Avoids tight coupling to a specific db/index.ts export shape; tests
 * and seed scripts can pass their own client.
 */
export type Database = PostgresJsDatabase<typeof schema>;

// ---------- Types ----------

export type Tier = 'main' | 'secondary' | 'isolation';
export type SetRole = 'warmup' | 'working' | 'top' | 'backoff';
export type ProgressionPolicy = 'standard' | 'cautious' | 'hold';

export type ExecutedSet = {
  position: number;
  load: number;
  reps: number;
  rir: number;
};

export type ProgressionInput = {
  tier: Tier;
  policy: ProgressionPolicy;
  /**
   * For 'main' tier: pass [topSet] (single-element array).
   * For 'secondary' / 'isolation': pass all working sets in position order.
   */
  relevantSets: ExecutedSet[];
  targetRepsMax: number;
  targetRir: number;
  /** 5 lb for upper body, 10 lb for lower body. Caller decides based on exercise. */
  increment: number;
  /** Computed by `computeConsecutiveBackwards()` (or 0 if insufficient history). */
  consecutiveBackwards: number;
};

export type ProgressionResult = {
  /** Suggested raw load (pre-plate-snap). Pass through plates.ts before display. */
  load: number;
  /** Human-readable explanation for UI provenance. */
  reasoning: string;
};

// ---------- Engine (pure function, no DB access) ----------

/**
 * Computes the suggested next load given executed history and prescription targets.
 *
 * Pure function — no DB access. Caller computes `consecutiveBackwards` separately
 * via `computeConsecutiveBackwards()`.
 */
export function suggestNextLoad(input: ProgressionInput): ProgressionResult {
  if (input.relevantSets.length === 0) {
    throw new Error('suggestNextLoad: relevantSets must not be empty');
  }

  const baseline = input.relevantSets[0].load;

  // Cautious / hold policy bypasses progression
  if (input.policy === 'cautious' || input.policy === 'hold') {
    return {
      load: baseline,
      reasoning:
        input.policy === 'hold'
          ? 'held: explicit hold policy'
          : 'held: cautious policy — manual advance only',
    };
  }

  // Reset rule: 2 consecutive backwards → 10% deload
  if (input.consecutiveBackwards >= 2) {
    return {
      load: round(baseline * 0.9),
      reasoning: '10% deload after 2 consecutive backwards sessions',
    };
  }

  if (input.tier === 'main') {
    return mainTierLogic(input);
  }
  return allSetsLogic(input);
}

function mainTierLogic(input: ProgressionInput): ProgressionResult {
  const top = input.relevantSets[0];
  const { increment, targetRepsMax, targetRir } = input;

  // Missed target reps → hold
  if (top.reps < targetRepsMax) {
    return {
      load: top.load,
      reasoning: `held: top set ${top.reps} reps below target ${targetRepsMax}`,
    };
  }

  // Crushed (RIR much lower than target, hit max reps) → bigger jump
  if (top.rir <= targetRir - 2) {
    return {
      load: top.load + increment * 2,
      reasoning: `+${increment * 2}: top set crushed at RIR ${top.rir} (target ${targetRir})`,
    };
  }

  // Hit target reps with RIR at or below target → standard bump
  if (top.rir <= targetRir) {
    return {
      load: top.load + increment,
      reasoning: `+${increment}: top set hit ${top.reps} reps at RIR ${top.rir}`,
    };
  }

  // Hit reps but didn't push hard enough → hold
  return {
    load: top.load,
    reasoning: `held: top set RIR ${top.rir} above target ${targetRir}`,
  };
}

function allSetsLogic(input: ProgressionInput): ProgressionResult {
  const baseline = input.relevantSets[0].load;
  const { increment, targetRepsMax, targetRir } = input;

  const allClearTop = input.relevantSets.every(
    (s) => s.reps >= targetRepsMax && s.rir <= targetRir,
  );

  if (allClearTop) {
    return {
      load: baseline + increment,
      reasoning: `+${increment}: all working sets at top of range, RIR ≤ ${targetRir}`,
    };
  }

  return {
    load: baseline,
    reasoning: 'held: not all working sets cleared top of range',
  };
}

// ---------- Helpers ----------

/**
 * Rounds a load to 0.5 lb precision. Final plate-snap happens in plates.ts.
 */
function round(load: number): number {
  return Math.round(load * 2) / 2;
}

/** 5 lb for upper-body exercises, 10 lb for lower-body exercises. */
export function defaultIncrement(isLowerBody: boolean): number {
  return isLowerBody ? 10 : 5;
}

// ---------- consecutiveBackwards computation (DB-touching) ----------

/**
 * v2.2 §1: count completed sessions where the relevant set failed to clear
 * the progression condition at the same or lower EXECUTED load relative to
 * the prior completed session.
 *
 * Computed from executed outcomes, not prior suggestions, because user
 * overrides are first-class.
 *
 * MVP simplification: this is a LOAD-ONLY PROXY for the v5 "backwards" rule.
 * It does NOT inspect reps/RIR clearance. Two same-load sessions count as
 * backwards even if reps improved within the load. Acceptable approximation
 * for MVP given override-is-first-class. The function keeps the "Backwards"
 * name to align with the v5 program doc; tighten the implementation (inspect
 * reps/RIR) if false-positive deloads become a real annoyance in practice.
 *
 * Algorithm:
 *   1. Fetch last N completed sets matching (exerciseId, setRole, position),
 *      filtered for non-null executed_load, non-null executed_reps, and ended
 *      sessions (per CLAUDE.md history-lookup rule).
 *   2. Walking from most-recent to older, count consecutive pairs where
 *      `executed_load[older] >= executed_load[newer]` (held or regressed).
 *   3. Stop on first "advanced" pair.
 *
 * Returns 0 if fewer than 2 completed sessions exist.
 */
export async function computeConsecutiveBackwards(
  db: Database,
  exerciseId: string,
  setRole: SetRole,
  position: number,
  lookback = 10,
): Promise<number> {
  const rows = await db
    .select({
      executedLoad: sets.executedLoad,
      loggedAt: sets.loggedAt,
    })
    .from(sets)
    .innerJoin(sessions, eq(sets.sessionId, sessions.id))
    .where(
      and(
        eq(sets.exerciseId, exerciseId),
        eq(sets.setRole, setRole),
        eq(sets.position, position),
        isNotNull(sets.executedLoad),
        isNotNull(sets.executedReps),
        isNotNull(sessions.endedAt),
      ),
    )
    .orderBy(desc(sets.loggedAt))
    .limit(lookback);

  if (rows.length < 2) return 0;

  let count = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const newer = rows[i].executedLoad;
    const older = rows[i + 1].executedLoad;
    if (newer === null || older === null) break;
    if (older >= newer) {
      count++;
    } else {
      break; // first "advanced" pair stops the count
    }
  }
  return count;
}

// ---------- History lookup helper (the prefill query from §11) ----------

export type HistoryRow = {
  executedLoad: number | null;
  executedReps: number | null;
  executedRir: number | null;
  prescribedRepsMin: number | null;
  prescribedRepsMax: number | null;
  prescribedRir: number | null;
};

/**
 * Fetches the most recent completed execution for (exerciseId, setRole, position).
 * Returns null if no history.
 *
 * Implements the v2.1 §11 prefill query with v2.2 §3 safety filters. These
 * filters apply to MVP-A's dumb prefill too — not just MVP-B's smart prefill.
 * Per CLAUDE.md, every history lookup uses these filters.
 *
 * `excludeSessionId` lets a session-view loader skip the session being
 * displayed — otherwise, once that session ends, its own set becomes "the
 * most recent completed" and the per-row "Last: …" duplicates the executed
 * value shown right above it.
 */
export async function getLastCompletedSet(
  db: Database,
  exerciseId: string,
  setRole: SetRole,
  position: number,
  excludeSessionId?: string,
): Promise<HistoryRow | null> {
  const rows = await db
    .select({
      executedLoad: sets.executedLoad,
      executedReps: sets.executedReps,
      executedRir: sets.executedRir,
      prescribedRepsMin: sets.prescribedRepsMin,
      prescribedRepsMax: sets.prescribedRepsMax,
      prescribedRir: sets.prescribedRir,
    })
    .from(sets)
    .innerJoin(sessions, eq(sets.sessionId, sessions.id))
    .where(
      and(
        eq(sets.exerciseId, exerciseId),
        eq(sets.setRole, setRole),
        eq(sets.position, position),
        isNotNull(sets.executedLoad),
        isNotNull(sets.executedReps),
        isNotNull(sessions.endedAt),
        excludeSessionId ? ne(sessions.id, excludeSessionId) : undefined,
      ),
    )
    .orderBy(desc(sets.loggedAt))
    .limit(1);

  return rows[0] ?? null;
}
