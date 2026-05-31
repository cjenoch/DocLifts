/**
 * Seed file for the Sunrise Center 4-Day Program v5 (planning v2.2).
 *
 * Place at: src/lib/server/db/seed.ts
 *
 * Run with:
 *   node --import tsx --env-file=.env src/lib/server/db/seed.ts
 *
 * Or as a package.json script:
 *   "seed": "node --import tsx --env-file=.env src/lib/server/db/seed.ts"
 *   then: pnpm seed
 *
 * WARNING: this clears existing rows in all tables before inserting.
 * Don't run on a database with sessions you care about.
 *
 * ---------- Conventions ----------
 *
 * UNITS for `initialLoad`:
 *   - Barbell exercises (deadlift, RDL): TOTAL bar+plate weight (e.g. 284).
 *     Plate calculator only runs for these.
 *   - Plate-loaded machines (Nautilus Leverage, Hack Squat, Glute Drive):
 *     PER-SIDE plate weight (e.g. 110 means "110 lb plates on each side").
 *   - Stack/selectorized machines (Inspiration series, Pec Deck, cables):
 *     stack-pin TOTAL value as displayed on the machine (e.g. 130).
 *   - Dumbbells: PER-DUMBBELL weight (e.g. 10 means "10 lb DBs in each hand").
 *   - Bodyweight: undefined/null.
 *
 * `targetRir` convention: upper bound of acceptable RIR.
 *   RIR 0-1 prescription → target_rir = 1.
 *   RIR 4+ (easy warmup) → target_rir = null.
 *
 * `targetRepsMin` / `targetRepsMax`: closed range. Equal values mean a single rep target.
 *
 * `restSecondsMin` / `restSecondsMax`: closed range. Last set of a session
 *   has null/null (rest after the set doesn't matter).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// ---------- DB connection ----------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL not set. Use --env-file=.env or export it.');
}

const client = postgres(DATABASE_URL);
const db = drizzle(client, { schema });

// ---------- Types ----------

type SetRole = 'warmup' | 'working' | 'top' | 'backoff';
type Tier = 'main' | 'secondary' | 'isolation';
type Metric = 'reps' | 'seconds';
type Policy = 'standard' | 'cautious' | 'hold';

type SetSpec = {
  role: SetRole;
  metric?: Metric;            // default 'reps'
  repsMin?: number;
  repsMax?: number;
  rir?: number;               // upper bound; omit for "easy" warmups (RIR 4+)
  initialLoad?: number;       // null/undefined = no cold-start value (user enters)
  restMin?: number | null;    // null = no rest target (typically last set)
  restMax?: number | null;
  notes?: string;
};

type ExerciseSpec = {
  name: string;
  tier: Tier;
  policy?: Policy;            // default 'standard'
  notes?: string;
  sets: SetSpec[];
};

type DaySpec = {
  name: string;
  position: number;
  alternateGroupId?: string;
  notes?: string;
  exercises: ExerciseSpec[];
};

// ---------- Default rests (seed-time helper) ----------

/**
 * v2.1 §7 decision: prescribed_sets carry their own rest targets (not
 * derived from tier at runtime). This helper computes defaults from
 * tier + role at SEED time only; the runtime engine reads what's stored.
 *
 * Convention: every prescribed_set has rest_seconds_min/max populated
 * EXCEPT terminal sets (the last set in an exercise), where null/null
 * means "no post-set rest target — exercise is over." See uses of
 * restMin: null below for back-off and final secondary/isolation sets.
 */
function defaultRest(tier: Tier, role: SetRole): { min: number; max: number } {
  if (role === 'warmup') return { min: 60, max: 90 };
  if (role === 'backoff') return { min: 60, max: 90 };
  if (tier === 'main') return { min: 180, max: 180 };
  if (tier === 'secondary') return { min: 120, max: 120 };
  return { min: 60, max: 90 }; // isolation
}

function defaultRestSpread(tier: Tier, role: SetRole): { restMin: number; restMax: number } {
  const r = defaultRest(tier, role);
  return { restMin: r.min, restMax: r.max };
}

// ---------- Standard set patterns ----------

/** 5-set MAIN ordering: 2 warmups, working 1, TOP (set 4), back-off. */
function standardMainSets(loads: {
  warmup1?: number;
  warmup2?: number;
  working?: number;
  top?: number;
  backoff?: number;
}): SetSpec[] {
  return [
    {
      role: 'warmup',
      repsMin: 10,
      repsMax: 12,
      initialLoad: loads.warmup1,
      ...defaultRestSpread('main', 'warmup'),
    },
    {
      role: 'warmup',
      repsMin: 6,
      repsMax: 8,
      rir: 4,
      initialLoad: loads.warmup2,
      ...defaultRestSpread('main', 'warmup'),
    },
    {
      role: 'working',
      repsMin: 8,
      repsMax: 8,
      rir: 3,
      initialLoad: loads.working,
      ...defaultRestSpread('main', 'working'),
    },
    {
      role: 'top',
      repsMin: 6,
      repsMax: 8,
      rir: 1,
      initialLoad: loads.top,
      ...defaultRestSpread('main', 'top'),
    },
    {
      role: 'backoff',
      repsMin: 8,
      repsMax: 10,
      rir: 1,
      initialLoad: loads.backoff,
      restMin: null,
      restMax: null,
    },
  ];
}

/** 2-set effort rule: set 1 RIR 1-3, set 2 RIR 0-1. Both sets share initial load. */
function twoWorkingSets(
  tier: Tier,
  repsMin: number,
  repsMax: number,
  initialLoad?: number,
): SetSpec[] {
  const r = defaultRest(tier, 'working');
  return [
    {
      role: 'working',
      repsMin,
      repsMax,
      rir: 3,
      initialLoad,
      restMin: r.min,
      restMax: r.max,
    },
    {
      role: 'working',
      repsMin,
      repsMax,
      rir: 1,
      initialLoad,
      restMin: null,
      restMax: null,
    },
  ];
}

// ---------- Equipment map ----------

type ExerciseMeta = { equipmentType: string; isLowerBody: boolean };

const exerciseMeta: Record<string, ExerciseMeta> = {
  'Nautilus Leverage Plate Press': { equipmentType: 'machine-plate', isLowerBody: false },
  'Inspiration Chest Press': { equipmentType: 'machine-stack', isLowerBody: false },
  'Pec Deck': { equipmentType: 'machine-stack', isLowerBody: false },
  'Inspiration Shoulder Press': { equipmentType: 'machine-stack', isLowerBody: false },
  'DB Lateral Raise': { equipmentType: 'dumbbell', isLowerBody: false },
  'Nautilus Triceps Extension': { equipmentType: 'machine-stack', isLowerBody: false },
  'Cable Face Pulls': { equipmentType: 'cable', isLowerBody: false },
  'Leverage Incline Lever Row': { equipmentType: 'machine-plate', isLowerBody: false },
  'Cable Seated Row - close grip': { equipmentType: 'cable', isLowerBody: false },
  'Cable Lat Pulldown - wide grip': { equipmentType: 'cable', isLowerBody: false },
  'Pec Fly / Rear Delt': { equipmentType: 'machine-stack', isLowerBody: false },
  'Inspiration Bicep Curl': { equipmentType: 'machine-stack', isLowerBody: false },
  'Preacher Curls (EZ bar)': { equipmentType: 'barbell-ez', isLowerBody: false },
  'Hanging Leg Raises': { equipmentType: 'bodyweight', isLowerBody: false },
  Deadlift: { equipmentType: 'barbell', isLowerBody: true },
  'Plate Loaded Leg Press': { equipmentType: 'machine-plate', isLowerBody: true },
  'Inspiration Leg Curl': { equipmentType: 'machine-stack', isLowerBody: true },
  'Inspiration Leg Extension': { equipmentType: 'machine-stack', isLowerBody: true },
  'Nautilus Glute Drive': { equipmentType: 'machine-plate', isLowerBody: true },
  'Smith Machine Calf Raise': { equipmentType: 'smith', isLowerBody: true },
  'Cable Crunch': { equipmentType: 'cable', isLowerBody: false },
  'Romanian Deadlift': { equipmentType: 'barbell', isLowerBody: true },
  'Hack Squat': { equipmentType: 'machine-plate', isLowerBody: true },
  'Leverage Lat Pulldown': { equipmentType: 'machine-plate', isLowerBody: false },
  'Cable Lat Pulldown - close grip': { equipmentType: 'cable', isLowerBody: false },
  'Cable Straight-Arm Pulldown': { equipmentType: 'cable', isLowerBody: false },
  'Cable Seated Row - wide grip': { equipmentType: 'cable', isLowerBody: false },
  'DB Hammer Curl': { equipmentType: 'dumbbell', isLowerBody: false },
  'Rotary Torso': { equipmentType: 'machine-stack', isLowerBody: false },
  'Band External Rotations': { equipmentType: 'band', isLowerBody: false },
  'Band Pull-Aparts': { equipmentType: 'band', isLowerBody: false },
  'DB Standing Calf Raise (1-leg)': { equipmentType: 'dumbbell', isLowerBody: true },
  'DB Wrist Curl + Reverse': { equipmentType: 'dumbbell', isLowerBody: false },
  'Plank / Side Plank': { equipmentType: 'bodyweight', isLowerBody: false },
};

// ---------- Program data ----------

const programName = 'Sunrise Center 4-Day Program v5';
const programDescription =
  'Push / Pull A (horizontal) / Legs / Pull B (vertical). Deadlift loads ' +
  'corrected for 44-lb bar / no bumpers. Wave loading on DL: Wk1A 284, ' +
  'Wk3A 304/314, Wk5A 324 PR, Wk7A 224 deload.';

const days: DaySpec[] = [
  // ---------- Day 1 - Push ----------
  {
    name: 'Day 1 - Push',
    position: 1,
    notes:
      '~50 min. 17 sets total. Calibrated from 5/4 session. ' +
      'Warm-up before main lift: 5 min easy cardio.',
    exercises: [
      {
        name: 'Nautilus Leverage Plate Press',
        tier: 'main',
        notes:
          'Top set is set 4. Plate-loaded — loads are PER SIDE. ' +
          'After 5/4: 100s × 12 was over rep range. ' +
          'If 110s unavailable, do 100 × 8-10 RIR 0-1 as top, ' +
          '90 × 10-12 as back-off, jump to 110 next session.',
        sets: standardMainSets({
          warmup1: 45,
          warmup2: 70,
          working: 90,
          top: 110,
          backoff: 100,
        }),
      },
      {
        name: 'Inspiration Chest Press',
        tier: 'secondary',
        notes:
          'Stack value. Calibrated 5/4 at 130. ' +
          'Hold 130 until both sets clear 10+ reps. RIR 0-2.',
        sets: twoWorkingSets('secondary', 8, 12, 130),
      },
      {
        name: 'Pec Deck',
        tier: 'secondary',
        notes: 'Stack value. Calibrated 5/4 at 70 (12, 8). Hold load.',
        sets: twoWorkingSets('secondary', 10, 15, 70),
      },
      {
        name: 'Inspiration Shoulder Press',
        tier: 'secondary',
        policy: 'cautious',
        notes:
          'Stack value. Hold 70 for now. SHOULDER CAUTION priority. ' +
          'Per v5 hard rules: bump to 75 only after 2-3 sessions clean ' +
          'at RIR 0-1, not session-to-session.',
        sets: twoWorkingSets('secondary', 8, 12, 70),
      },
      {
        name: 'DB Lateral Raise',
        tier: 'isolation',
        policy: 'cautious',
        notes:
          'Per dumbbell. Hold 10s. SHOULDER CAUTION priority. ' +
          'Bump to 12.5s only when 15 reps comes easy at RIR 0-1, ' +
          'not session-to-session.',
        sets: twoWorkingSets('isolation', 12, 15, 10),
      },
      {
        name: 'Nautilus Triceps Extension',
        tier: 'isolation',
        notes:
          'Stack value. Target 140-145. Verify load by counting plates ' +
          '— last session machine read 165 by mistake.',
        sets: twoWorkingSets('isolation', 10, 12, 145),
      },
      {
        name: 'Cable Face Pulls',
        tier: 'isolation',
        notes: 'Cable stack ~16.5. PREHAB. MANDATORY every push day.',
        sets: [
          {
            role: 'working',
            repsMin: 15,
            repsMax: 15,
            rir: 3,
            initialLoad: 16.5,
            ...defaultRestSpread('isolation', 'working'),
          },
          {
            role: 'working',
            repsMin: 15,
            repsMax: 15,
            rir: 1,
            initialLoad: 16.5,
            restMin: null,
            restMax: null,
          },
        ],
      },
    ],
  },

  // ---------- Day 2 - Pull A: Horizontal ----------
  {
    name: 'Day 2 - Pull A: Horizontal Bias',
    position: 2,
    notes:
      '~50 min. 17 sets total. Rows fresh, before deadlift day. ' +
      'This is the money pull session — row hard while fresh.',
    exercises: [
      {
        name: 'Leverage Incline Lever Row',
        tier: 'main',
        notes:
          'Plate-loaded — loads are PER SIDE. ' +
          'Top set is set 4 at 95s/side. ' +
          'Anchored to 4/29 (90 × 7-5, post-DL fatigue). ' +
          'Fresh on Day 2 should clear 95 × 6-8 cleanly. ' +
          'If 95 lands at RIR 0 with 6 reps, hold next session. ' +
          'If 8+ reps RIR 0-1, jump to 100s.',
        sets: standardMainSets({
          warmup1: 45,
          warmup2: 70,
          working: 80,
          top: 95,
          backoff: 85,
        }),
      },
      {
        name: 'Cable Seated Row - close grip',
        tier: 'secondary',
        notes:
          'Cable stack. Strict, no body english. RIR 0-2 last set. ' +
          'Target 100-110.',
        sets: twoWorkingSets('secondary', 10, 12, 105),
      },
      {
        name: 'Cable Lat Pulldown - wide grip',
        tier: 'secondary',
        notes:
          "Cable stack. Day 2's lat work; secondary today. Target 120-140.",
        sets: twoWorkingSets('secondary', 10, 12, 130),
      },
      {
        name: 'Pec Fly / Rear Delt',
        tier: 'isolation',
        notes:
          'Stack value, rear delt setting. Pull elbows back, not hands. ' +
          'Target 50-60.',
        sets: twoWorkingSets('isolation', 12, 15, 55),
      },
      {
        name: 'Inspiration Bicep Curl',
        tier: 'isolation',
        notes: 'Stack value. Slow eccentric. Target 125-130.',
        sets: twoWorkingSets('isolation', 10, 12, 127),
      },
      {
        name: 'Preacher Curls (EZ bar)',
        tier: 'isolation',
        notes:
          'Total bar weight. EZ bar (~25 lb) + ~22 per side ≈ 70 total. ' +
          'Strict form.',
        sets: twoWorkingSets('isolation', 10, 12, 70),
      },
      {
        name: 'Hanging Leg Raises',
        tier: 'isolation',
        notes: 'Bodyweight. Slow controlled. Pause at top.',
        sets: twoWorkingSets('isolation', 8, 12, undefined),
      },
    ],
  },

  // ---------- Day 3A - Legs Week A (Heavy DL) ----------
  {
    name: 'Day 3 - Legs (Week A: Heavy Deadlift)',
    position: 3,
    alternateGroupId: 'legs',
    notes:
      '~55-65 min. Includes 4 deadlift warm-up sets. ' +
      'Warm-up before main lift: 5 min bike + dynamic hip work.',
    exercises: [
      {
        name: 'Deadlift',
        tier: 'main',
        // Wave loading makes 'standard' linear progression wrong on every
        // wave-shift week (Wk1A→3A +20, 3A→5A +20, 5A→7A -100). 'hold' makes
        // the engine stay silent on deadlift; user inputs wave-plan target
        // directly. Lower friction over an 8-week cycle than standard. Flip
        // to 'standard' if/when the engine learns wave loading explicitly.
        policy: 'hold',
        notes:
          'Total bar weight. 44 lb bar, 134 lb floor. ' +
          'Plate increments: 134/184/224/244/264/284/304/314/324. ' +
          'Wave loading: Wk1A 284, Wk3A 304 (or 314 if Wk1A easy), ' +
          'Wk5A 324 PR, Wk7A deload to 224 × 5 × 3. ' +
          'If Wk1A 284 lands RIR 3+, jump Wk3A directly to 314.',
        sets: [
          {
            role: 'warmup',
            repsMin: 8,
            repsMax: 10,
            initialLoad: 134,
            restMin: 60,
            restMax: 90,
            notes: '134 (bar + 45/side)',
          },
          {
            role: 'warmup',
            repsMin: 5,
            repsMax: 5,
            initialLoad: 184,
            restMin: 90,
            restMax: 90,
            notes: '184 (45+25/side)',
          },
          {
            role: 'warmup',
            repsMin: 3,
            repsMax: 3,
            rir: 4,
            initialLoad: 224,
            restMin: 90,
            restMax: 90,
            notes: '224 (45+45/side)',
          },
          {
            role: 'warmup',
            repsMin: 1,
            repsMax: 1,
            rir: 3,
            initialLoad: 254,
            restMin: 120,
            restMax: 120,
            notes: '254 (45+45+10+5/side), heavy single',
          },
          {
            role: 'working',
            repsMin: 3,
            repsMax: 3,
            rir: 3,
            initialLoad: 244,
            restMin: 180,
            restMax: 180,
            notes: '244',
          },
          {
            role: 'top',
            repsMin: 3,
            repsMax: 3,
            rir: 1,
            initialLoad: 284,
            restMin: 180,
            restMax: 180,
            notes: '284 (Wk1A target)',
          },
          {
            role: 'backoff',
            repsMin: 5,
            repsMax: 5,
            rir: 2,
            initialLoad: 244,
            restMin: null,
            restMax: null,
            notes: '244',
          },
        ],
      },
      {
        name: 'Plate Loaded Leg Press',
        tier: 'secondary',
        notes:
          'Plate-loaded — PER SIDE. Heavy DL week = leg press as 2nd ' +
          'movement. Hack squat OUT this week. Target 3-4 plates/side ' +
          '(135-180 per side). Conservative starter: 135.',
        sets: twoWorkingSets('secondary', 8, 12, 135),
      },
      {
        name: 'Inspiration Leg Curl',
        tier: 'secondary',
        notes: 'Stack value. Pause at full contraction. Target 180-190.',
        sets: twoWorkingSets('secondary', 10, 12, 185),
      },
      {
        name: 'Inspiration Leg Extension',
        tier: 'isolation',
        notes: 'Stack value. Hold top 1 sec. Target 195-215.',
        sets: twoWorkingSets('isolation', 10, 15, 205),
      },
      {
        name: 'Nautilus Glute Drive',
        tier: 'secondary',
        notes:
          'Plate-loaded — PER SIDE. Pause at lockout. Target 70-90 per side.',
        sets: twoWorkingSets('secondary', 10, 12, 80),
      },
      {
        name: 'Smith Machine Calf Raise',
        tier: 'isolation',
        notes:
          'Smith bar weight. Full ROM, slow eccentric. Target 60-90. ' +
          'Respond well in 15-20 rep range.',
        sets: twoWorkingSets('isolation', 15, 20, 75),
      },
      {
        name: 'Cable Crunch',
        tier: 'isolation',
        notes:
          'Cable stack. Start light (user determines). Replaces Gym 80 ' +
          'total ab. Kneel facing away, rope, round spine.',
        sets: twoWorkingSets('isolation', 12, 15, undefined),
      },
    ],
  },

  // ---------- Day 3B - Legs Week B (Light, Hack primary) ----------
  {
    name: 'Day 3 - Legs (Week B: Light / Skip DL)',
    position: 4,
    alternateGroupId: 'legs',
    notes:
      '~50-55 min. Hack squat primary this week. Lower back recovery week. ' +
      'Warm-up: 5 min bike + dynamic hip work.',
    exercises: [
      {
        name: 'Romanian Deadlift',
        tier: 'secondary',
        notes:
          'Total bar weight. Light hinge volume only — no top sets. ' +
          'OR skip entirely. Target 184-224. ' +
          '(199 chosen over 200 for plate-achievability with 44-lb bar.)',
        sets: twoWorkingSets('secondary', 6, 8, 199),
      },
      {
        name: 'Hack Squat',
        tier: 'main',
        notes:
          'Plate-loaded — PER SIDE. MAIN this week. New to you. ' +
          'First Week B session: dial in form on warm-ups, then see ' +
          'what 60s/side feels like for working set 1 before deciding ' +
          'the top set load. Loads will adjust.',
        sets: [
          {
            role: 'warmup',
            repsMin: 8,
            repsMax: 8,
            initialLoad: 0,
            restMin: 60,
            restMax: 60,
            notes: 'Empty sled',
          },
          {
            role: 'warmup',
            repsMin: 6,
            repsMax: 6,
            initialLoad: 25,
            restMin: 90,
            restMax: 90,
            notes: '25/side',
          },
          {
            role: 'warmup',
            repsMin: 5,
            repsMax: 5,
            rir: 4,
            initialLoad: 45,
            restMin: 90,
            restMax: 90,
            notes: '45/side',
          },
          {
            role: 'working',
            repsMin: 8,
            repsMax: 8,
            rir: 3,
            initialLoad: 60,
            restMin: 180,
            restMax: 180,
            notes: '60s/side',
          },
          {
            role: 'top',
            repsMin: 6,
            repsMax: 8,
            rir: 1,
            initialLoad: 70,
            restMin: 180,
            restMax: 180,
            notes: '70s/side calibration',
          },
          {
            role: 'backoff',
            repsMin: 10,
            repsMax: 12,
            rir: 1,
            initialLoad: 55,
            restMin: null,
            restMax: null,
            notes: '55s/side',
          },
        ],
      },
      {
        name: 'Inspiration Leg Curl',
        tier: 'secondary',
        notes: 'Stack value. Pause at full contraction. Target 180-190.',
        sets: twoWorkingSets('secondary', 10, 12, 185),
      },
      {
        name: 'Inspiration Leg Extension',
        tier: 'isolation',
        notes:
          'Stack value. Full effort — back-friendly week. Target 195-215.',
        sets: twoWorkingSets('isolation', 10, 15, 205),
      },
      {
        name: 'Nautilus Glute Drive',
        tier: 'secondary',
        notes:
          'Plate-loaded — PER SIDE. Pause at lockout. Target 70-90 per side.',
        sets: twoWorkingSets('secondary', 10, 12, 80),
      },
      {
        name: 'Smith Machine Calf Raise',
        tier: 'isolation',
        notes: 'Smith bar weight. Full ROM. Target 60-90.',
        sets: twoWorkingSets('isolation', 15, 20, 75),
      },
      {
        name: 'Cable Crunch',
        tier: 'isolation',
        notes: 'Cable stack. Start light. Same as Week A.',
        sets: twoWorkingSets('isolation', 12, 15, undefined),
      },
    ],
  },

  // ---------- Day 4 - Pull B: Vertical (NOT max effort) ----------
  {
    name: 'Day 4 - Pull B: Vertical Bias',
    position: 5,
    notes:
      '~40 min. 12 working sets. NOT a max-effort day. ' +
      "Don't try to PR — you'll erode recovery for next Monday. " +
      'All rowing is chest-supported or cable.',
    exercises: [
      {
        name: 'Leverage Lat Pulldown',
        tier: 'secondary',
        notes:
          "Plate-loaded — PER SIDE. Lighter than Day 2's row. " +
          'NOT a PR target today. Target 95-100 per side.',
        sets: twoWorkingSets('secondary', 6, 10, 100),
      },
      {
        name: 'Cable Lat Pulldown - close grip',
        tier: 'secondary',
        notes: 'Cable stack. Different grip than Day 2. Target 120-140.',
        sets: twoWorkingSets('secondary', 10, 12, 130),
      },
      {
        name: 'Cable Straight-Arm Pulldown',
        tier: 'isolation',
        notes: 'Cable stack. Lat isolation. Arms locked. Target ~50.',
        sets: twoWorkingSets('isolation', 12, 15, 50),
      },
      {
        name: 'Cable Seated Row - wide grip',
        tier: 'secondary',
        notes:
          'Cable stack. Pump volume, not PR target. ' +
          'Different attachment than Day 2. Target 100-110.',
        sets: twoWorkingSets('secondary', 10, 12, 105),
      },
      {
        name: 'DB Hammer Curl',
        tier: 'isolation',
        notes:
          'Per dumbbell. Forearms + brachialis. Target 30-45 per dumbbell.',
        sets: twoWorkingSets('isolation', 10, 12, 37.5),
      },
      {
        name: 'Rotary Torso',
        tier: 'isolation',
        notes: "Stack value. Don't let momentum take over. Target 60-80.",
        sets: twoWorkingSets('isolation', 12, 15, 70),
      },
    ],
  },

  // ---------- Day 5 - Optional Home Accessory ----------
  {
    name: 'Day 5 - Optional Home Accessory',
    position: 6,
    notes:
      '~20 min. Prehab + small muscles. Skip if recovery is tight. ' +
      'Insurance, not a growth driver. If only 10 min: bands + planks ' +
      '(highest-ROI subset). Do NOT add another arm day here.',
    exercises: [
      {
        name: 'Band External Rotations',
        tier: 'isolation',
        policy: 'cautious',
        notes:
          'Band tension (no numeric load). Right shoulder prehab. ' +
          '15 reps each side.',
        sets: twoWorkingSets('isolation', 15, 15, undefined),
      },
      {
        name: 'Band Pull-Aparts',
        tier: 'isolation',
        notes: 'Band tension. Scap retraction.',
        sets: twoWorkingSets('isolation', 20, 20, undefined),
      },
      {
        name: 'DB Standing Calf Raise (1-leg)',
        tier: 'isolation',
        notes: 'Per dumbbell or BW. Slow eccentric.',
        sets: twoWorkingSets('isolation', 15, 20, undefined),
      },
      {
        name: 'DB Wrist Curl + Reverse',
        tier: 'isolation',
        notes: 'Per dumbbell. Forearm work. Target 10-25.',
        sets: twoWorkingSets('isolation', 15, 15, 17.5),
      },
      {
        name: 'Plank / Side Plank',
        tier: 'isolation',
        notes:
          'Bodyweight, time-based. Anti-extension/anti-lateral-flexion. ' +
          'Target 30-60 seconds per hold.',
        sets: [
          {
            role: 'working',
            metric: 'seconds',
            repsMin: 30,
            repsMax: 60,
            rir: 3,
            ...defaultRestSpread('isolation', 'working'),
          },
          {
            role: 'working',
            metric: 'seconds',
            repsMin: 30,
            repsMax: 60,
            rir: 1,
            restMin: null,
            restMax: null,
          },
        ],
      },
    ],
  },
];

// ---------- Seed function ----------

async function seed() {
  // Dedupe exercises across all days
  const exerciseNames = new Set<string>();
  for (const day of days) {
    for (const ex of day.exercises) {
      exerciseNames.add(ex.name);
    }
  }

  const dayExerciseCount = days.reduce(
    (sum, d) => sum + d.exercises.length,
    0,
  );
  const prescribedSetCount = days.reduce(
    (sum, d) =>
      sum + d.exercises.reduce((s, e) => s + e.sets.length, 0),
    0,
  );

  await db.transaction(async (tx) => {
    console.log('Clearing existing data...');
    await tx.delete(schema.painEvents);
    await tx.delete(schema.sets);
    await tx.delete(schema.sessions);
    await tx.delete(schema.prescribedSets);
    await tx.delete(schema.dayExercises);
    await tx.delete(schema.days);
    await tx.delete(schema.exercises);
    await tx.delete(schema.programs);

    console.log(`Inserting program: ${programName}`);
    const [program] = await tx
      .insert(schema.programs)
      .values({
        name: programName,
        description: programDescription,
        isActive: true,
      })
      .returning();

    console.log(`Inserting ${exerciseNames.size} unique exercises...`);
    const exerciseMap = new Map<string, string>();
    for (const name of exerciseNames) {
      // Fail-fast on missing mapping. Equipment type controls plate-snap math
      // via snapForEquipment(); a silent ?? null fallback would route a
      // typo'd or new exercise through the pass-through branch and quietly
      // produce wrong loads on barbell/machine-plate exercises.
      const meta = exerciseMeta[name];
      if (!meta) {
        throw new Error(
          `Missing exercise metadata for exercise: "${name}". ` +
            `Add it to the exerciseMeta map at the top of seed.ts.`,
        );
      }
      const [exercise] = await tx
        .insert(schema.exercises)
        .values({ name, equipmentType: meta.equipmentType, isLowerBody: meta.isLowerBody })
        .returning();
      exerciseMap.set(name, exercise.id);
    }

    console.log(
      `Inserting ${days.length} days, ${dayExerciseCount} day_exercises, ${prescribedSetCount} prescribed_sets...`,
    );
    for (const daySpec of days) {
      const [day] = await tx
        .insert(schema.days)
        .values({
          programId: program.id,
          name: daySpec.name,
          position: daySpec.position,
          alternateGroupId: daySpec.alternateGroupId ?? null,
          notes: daySpec.notes,
        })
        .returning();

      let exPosition = 1;
      for (const exSpec of daySpec.exercises) {
        const exerciseId = exerciseMap.get(exSpec.name);
        if (!exerciseId) {
          throw new Error(`Exercise not found in map: ${exSpec.name}`);
        }

        const [dayExercise] = await tx
          .insert(schema.dayExercises)
          .values({
            dayId: day.id,
            exerciseId,
            position: exPosition++,
            tier: exSpec.tier,
            progressionPolicy: exSpec.policy ?? 'standard',
            notes: exSpec.notes,
          })
          .returning();

        let setPosition = 1;
        for (const setSpec of exSpec.sets) {
          await tx.insert(schema.prescribedSets).values({
            dayExerciseId: dayExercise.id,
            position: setPosition++,
            setRole: setSpec.role,
            targetMetric: setSpec.metric ?? 'reps',
            targetRepsMin: setSpec.repsMin ?? null,
            targetRepsMax: setSpec.repsMax ?? null,
            targetRir: setSpec.rir ?? null,
            initialLoad: setSpec.initialLoad ?? null,
            restSecondsMin: setSpec.restMin ?? null,
            restSecondsMax: setSpec.restMax ?? null,
            notes: setSpec.notes,
          });
        }
      }
    }
  });

  console.log('\nSeed complete:');
  console.log(`  programs:         1`);
  console.log(`  days:             ${days.length}`);
  console.log(`  exercises:        ${exerciseNames.size}`);
  console.log(`  day_exercises:    ${dayExerciseCount}`);
  console.log(`  prescribed_sets:  ${prescribedSetCount}`);
  console.log('\nVerification queries to run manually:');
  console.log(`  SELECT e.name, de.progression_policy FROM day_exercises de JOIN exercises e ON de.exercise_id = e.id WHERE de.progression_policy != 'standard' ORDER BY de.progression_policy, e.name;`);
  console.log(`  SELECT name, alternate_group_id FROM days WHERE alternate_group_id IS NOT NULL;`);
  console.log(`  SELECT count(*) FROM prescribed_sets WHERE initial_load IS NULL;`);
  console.log(`  SELECT name, target_metric FROM prescribed_sets ps JOIN day_exercises de ON ps.day_exercise_id = de.id JOIN exercises e ON de.exercise_id = e.id WHERE target_metric = 'seconds';`);
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await client.end();
  });
