import { z } from 'zod';

// Serialized JSON characters, shared by review and both POST actions.
export const MAX_PROGRAM_DRAFT_CHARS = 250_000;
// Leave headroom below adapter-node's default 512 KiB body limit.
export const MAX_PROGRAM_FORM_BYTES = 500_000;

export function programFormBytes(draft: ProgramDraft, requestId: string): number {
	// Match the form's two named hidden fields and UTF-8 urlencoded transport.
	// URLSearchParams serializes to ASCII, so character length is byte length.
	return new URLSearchParams({ payload: JSON.stringify(draft), requestId }).toString().length;
}

const name = z.string().trim().min(1).max(200);
const notes = z.string().max(5000).nullable();
const whole = (min: number, max: number) => z.number().int().min(min).max(max);
const setSchema = z
	.object({
		setRole: z.enum(['warmup', 'top', 'backoff', 'working']),
		targetMetric: z.enum(['reps', 'seconds']),
		targetRepsMin: whole(1, 3600),
		targetRepsMax: whole(1, 3600),
		targetRir: whole(0, 10).nullable(),
		restSecondsMin: whole(0, 3600).nullable(),
		restSecondsMax: whole(0, 3600).nullable(),
		initialLoad: z
			.number()
			.min(0)
			.max(999)
			.refine(
				(value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
				'Load must have at most two decimal places'
			)
			.nullable(),
		notes
	})
	.strict()
	.superRefine((set, ctx) => {
		if (set.targetRepsMin > set.targetRepsMax)
			ctx.addIssue({
				code: 'custom',
				path: ['targetRepsMax'],
				message: 'Maximum target must be at least minimum target'
			});
		if (
			set.restSecondsMin !== null &&
			set.restSecondsMax !== null &&
			set.restSecondsMin > set.restSecondsMax
		)
			ctx.addIssue({
				code: 'custom',
				path: ['restSecondsMax'],
				message: 'Maximum rest must be at least minimum rest'
			});
	});
const exerciseSchema = z
	.object({
		exerciseId: z.string().uuid().nullable(),
		newExercise: z
			.object({
				name,
				equipmentType: z
					.enum([
						'barbell',
						'barbell-ez',
						'machine-plate',
						'machine-stack',
						'cable',
						'dumbbell',
						'smith',
						'bodyweight',
						'band'
					])
					.transform((value): string => value),
				isLowerBody: z.boolean()
			})
			.strict()
			.nullable(),
		tier: z.enum(['main', 'secondary', 'isolation']),
		progressionPolicy: z.enum(['standard', 'cautious', 'hold']),
		notes,
		sets: z.array(setSchema).min(1).max(30)
	})
	.strict()
	.superRefine((exercise, ctx) => {
		if ((exercise.exerciseId === null) === (exercise.newExercise === null))
			ctx.addIssue({
				code: 'custom',
				path: ['exerciseId'],
				message: 'Choose exactly one library exercise or new exercise'
			});
		const firstWork = exercise.sets.findIndex((set) => set.setRole !== 'warmup');
		const work = firstWork === -1 ? [] : exercise.sets.slice(firstWork);
		const valid =
			work.length > 0 &&
			(exercise.tier === 'main'
				? work[0].setRole === 'top' && work.slice(1).every((set) => set.setRole === 'backoff')
				: work.every((set) => set.setRole === 'working'));
		if (!valid)
			ctx.addIssue({
				code: 'custom',
				path: ['sets'],
				message:
					exercise.tier === 'main'
						? 'MAIN requires one top followed only by backoffs, with optional leading warmups'
						: 'SECONDARY and ISOLATION require working sets with optional leading warmups'
			});
	});

// Positions are intentionally absent: array order is the only source of position.
export const programDraftSchema = z
	.object({
		name,
		description: notes,
		days: z
			.array(
				z
					.object({
						name,
						notes,
						alternateGroupId: z.string().trim().min(1).max(100).nullable(),
						exercises: z.array(exerciseSchema).min(1).max(50)
					})
					.strict()
			)
			.min(1)
			.max(31)
	})
	.strict();
export type ProgramDraft = z.infer<typeof programDraftSchema>;

export function blankSetDraft(): ProgramDraft['days'][number]['exercises'][number]['sets'][number] {
	return {
		setRole: 'working',
		targetMetric: 'reps',
		targetRepsMin: 8,
		targetRepsMax: 12,
		targetRir: 2,
		restSecondsMin: 90,
		restSecondsMax: 120,
		initialLoad: null,
		notes: null
	};
}
export function blankExerciseDraft(): ProgramDraft['days'][number]['exercises'][number] {
	return {
		exerciseId: null,
		newExercise: null,
		tier: 'secondary',
		progressionPolicy: 'standard',
		notes: null,
		sets: [blankSetDraft()]
	};
}
export function blankProgramDraft(): ProgramDraft {
	return {
		name: '',
		description: null,
		days: [
			{ name: 'Day 1', notes: null, alternateGroupId: null, exercises: [blankExerciseDraft()] }
		]
	};
}
