/**
 * Plate calculator for the Lift Log app.
 *
 * Place at: src/lib/server/plates.ts
 *
 * Snaps a target load to the closest plate-achievable load.
 *
 * Used at the END of the session-start pipeline (after history lookup and
 * progression engine), per planning §16:
 *
 *   history → progression engine → plate snap (this) → display
 *
 * Equipment dispatch (per CLAUDE.md):
 *   - 'barbell':       total bar+plate weight; snap subtracts bar, halves, snaps plates per side
 *   - 'barbell-ez':    same as 'barbell' but with EZ bar weight
 *   - 'machine-plate': per-side plate weight; snap directly on plate sums
 *   - everything else: pass-through (load IS the displayed value, no snap)
 *
 * Callers should use `snapForEquipment(load, equipmentType)` rather than calling
 * `snapToAchievable` directly. The router handles the mode.
 */

import { gymConfig } from './gym-config';

// ---------- Types ----------

export type SnapResult = {
  achievable: number;
  platesUsed: number[]; // per side, biggest first
};

export type EquipmentType =
  | 'barbell'
  | 'barbell-ez'
  | 'machine-plate'
  | 'machine-stack'
  | 'cable'
  | 'dumbbell'
  | 'smith'
  | 'bodyweight'
  | 'band'
  | string; // fall-through for any future equipment

// ---------- Algorithm primitives ----------

/**
 * Greedy plate-sum solver: prefer biggest plates first, add smallest needed
 * to fill the gap. Returns the closest sum <= target using available denominations.
 *
 * Pure function. No bar math — that's done by the callers.
 *
 * v2.2 disclaimer: greedy is provably optimal for canonical coin systems and
 * works correctly for the standard plate set. If real test cases reveal closer-
 * but-missed combinations under non-standard plate inventories, replace with
 * bounded subset search. Don't pre-build that.
 */
function greedyPlateSum(
  targetPerSide: number,
  plates: readonly number[],
): { sum: number; used: number[] } {
  if (targetPerSide <= 0) return { sum: 0, used: [] };

  const sorted = [...plates].sort((a, b) => b - a);
  const used: number[] = [];
  let remaining = targetPerSide;

  for (const plate of sorted) {
    while (remaining >= plate) {
      used.push(plate);
      remaining -= plate;
    }
  }

  const sum = used.reduce((s, p) => s + p, 0);
  return { sum, used };
}

// ---------- Snap functions for each mode ----------

/**
 * Barbell snap: input is TOTAL bar+plate weight. Subtracts bar, halves, snaps,
 * doubles and adds bar back.
 *
 * If `targetLoad <= bar`, returns bar weight only (no plates).
 */
export function snapToAchievable(
  targetLoad: number,
  bar: number = gymConfig.bars.standard,
  plates: readonly number[] = gymConfig.platesPerSide,
): SnapResult {
  if (targetLoad <= bar) {
    return { achievable: bar, platesUsed: [] };
  }
  const perSide = (targetLoad - bar) / 2;
  const { sum, used } = greedyPlateSum(perSide, plates);
  return { achievable: bar + 2 * sum, platesUsed: used };
}

/**
 * Per-side machine snap: input is PER-SIDE plate weight (no bar to subtract).
 * Used for plate-loaded machines: Leverage Press/Row/Lat Pulldown, Hack Squat,
 * Glute Drive, Plate Loaded Leg Press.
 */
export function snapPerSidePlates(
  targetPerSide: number,
  plates: readonly number[] = gymConfig.platesPerSide,
): SnapResult {
  const { sum, used } = greedyPlateSum(targetPerSide, plates);
  return { achievable: sum, platesUsed: used };
}

// ---------- Router ----------

/**
 * Routes to the right snap function based on equipment type. Pass-through for
 * non-snappable equipment (machines with discrete stack values, dumbbells, cables,
 * bodyweight, bands).
 *
 * This is the function the session-start pipeline should call. It handles the
 * mode dispatch so callers don't have to remember the rules.
 */
export function snapForEquipment(
  targetLoad: number,
  equipmentType: EquipmentType | null | undefined,
): SnapResult {
  switch (equipmentType) {
    case 'barbell':
      return snapToAchievable(targetLoad, gymConfig.bars.standard);
    case 'barbell-ez':
      return snapToAchievable(targetLoad, gymConfig.bars.ezBar);
    case 'machine-plate':
      return snapPerSidePlates(targetLoad);
    default:
      // 'machine-stack', 'cable', 'dumbbell', 'smith', 'bodyweight', 'band',
      // null, or anything unknown: pass through. The displayed value IS the load.
      return { achievable: targetLoad, platesUsed: [] };
  }
}

// ---------- Test fixtures (v5 deadlift increments) ----------

/**
 * v5 deadlift achievable loads. Each must round-trip exactly under the standard
 * gym config (44 lb bar, [45, 35, 25, 20, 15, 10, 5, 2.5] plates). Used as the
 * test fixture in plates.test.ts.
 *
 * Verified arithmetic:
 *   134 = 44 + 2×(45)
 *   184 = 44 + 2×(45+25)
 *   224 = 44 + 2×(45+45)
 *   244 = 44 + 2×(45+45+10)
 *   254 = 44 + 2×(45+45+10+5)
 *   264 = 44 + 2×(45+45+20)
 *   284 = 44 + 2×(45+45+25+5)
 *   304 = 44 + 2×(45+45+35+5)
 *   314 = 44 + 2×(45+45+45)
 *   324 = 44 + 2×(45+45+45+5)
 */
export const v5DeadliftIncrements = [
  134, 184, 224, 244, 254, 264, 284, 304, 314, 324,
] as const;
