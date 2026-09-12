import {
	computeConsecutiveBackwards,
	defaultIncrement,
	suggestNextLoad,
	type Database,
	type PerformanceIdentity,
	type ProgressionPolicy,
	type SetRole,
	type getLastCompletedSet
} from './progression';

type History = Awaited<ReturnType<typeof getLastCompletedSet>>;
export type MainSlot = {
	position: number;
	setRole: SetRole;
	targetRepsMax: number | null;
	targetRepsMin: number | null;
	targetRir: number | null;
	history: History;
};

/** Raw loads only: callers retain cold-start handling and snap after this decision.
 * Exactly one actual top drives MAIN. Backoffs keep their executed-load ratio;
 * their own reps/RIR/streak never become inputs to the progression engine.
 */
export async function mainPrefills(
	db: Database,
	exerciseId: string,
	slots: MainSlot[],
	policy: ProgressionPolicy,
	isLowerBody: boolean,
	identity?: PerformanceIdentity
): Promise<Map<number, { load: number | null; reasoning: string | null }>> {
	const tops = slots.filter((s) => s.setRole === 'top');
	const top = tops.length === 1 ? tops[0] : undefined;
	const h = top?.history;
	const baseline = h?.executedLoad;
	const decision =
		top && h && baseline != null
			? suggestNextLoad({
					tier: 'main',
					policy,
					relevantSets: [
						{
							position: top.position,
							load: baseline,
							reps: h.executedReps!,
							rir: h.executedRir ?? top.targetRir ?? h.prescribedRir ?? 0
						}
					],
					targetRepsMax: top.targetRepsMax ?? h.prescribedRepsMax ?? top.targetRepsMin ?? 0,
					targetRir: top.targetRir ?? h.prescribedRir ?? 0,
					increment: defaultIncrement(isLowerBody),
					consecutiveBackwards: await computeConsecutiveBackwards(
						db,
						exerciseId,
						'top',
						top.position,
						10,
						identity
					)
				})
			: null;
	const result = new Map<number, { load: number | null; reasoning: string | null }>();
	for (const slot of slots) {
		const load = slot.history?.executedLoad ?? null;
		if (slot.setRole === 'warmup' || load == null) {
			result.set(slot.position, { load, reasoning: null });
		} else if (!decision || baseline == null) {
			result.set(slot.position, {
				load,
				reasoning: 'held: missing or ambiguous MAIN top-set history'
			});
		} else if (slot === top) {
			result.set(slot.position, { load: decision.load, reasoning: decision.reasoning });
		} else if (slot.setRole === 'backoff' && baseline > 0) {
			result.set(slot.position, {
				load: decision.kind === 'hold' ? load : (load * decision.load) / baseline,
				reasoning: `backoff ratio retained from top set: ${decision.reasoning}`
			});
		} else {
			result.set(slot.position, {
				load,
				reasoning: 'held: no valid MAIN backoff ratio to top set'
			});
		}
	}
	return result;
}
