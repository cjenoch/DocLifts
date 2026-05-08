/**
 * Gym hardware configuration.
 *
 * Place at: src/lib/server/gym-config.ts
 *
 * Single-gym hardcoded config for MVP. When multi-gym arrives post-MVP, promote
 * this to a `gyms` table with per-row plate inventory and have callers pass a
 * `gymId` instead of importing a singleton.
 *
 * Imported by: plates.ts (for snap-to-achievable math), seed.ts (potentially
 * for sanity checks).
 */

export const gymConfig = {
  bars: {
    standard: 44,        // lb. Used for deadlift, RDL, similar 'barbell' equipment.
    ezBar: 25,           // lb. Used for 'barbell-ez' (preacher curls etc.).
  },
  // Available DENOMINATIONS (lb), not inventory counts. The plate-snap algorithm
  // assumes enough plates of each denomination exist (true at most commercial
  // gyms and well-equipped home gyms). Per planning v2.2 patch 2.
  platesPerSide: [45, 35, 25, 20, 15, 10, 5, 2.5] as const,
} as const;

export type GymConfig = typeof gymConfig;
