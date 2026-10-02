/**
 * Stage timings for the photo upload log line (0.5.3).
 *
 * The caller hands `uploadPhoto` and `analyzePhoto` one `PhotoTimings` record
 * and each stage writes its own field when it finishes, whether it succeeded
 * or threw, so a refused or failed request still reports the time it spent.
 * A field stays `null` when the request never reached that stage. Measurement
 * only: nothing reads these values except the log line.
 */

export type PhotoTimings = {
	/** `processPhoto` (sharp): validate, orient, resize, re-encode, strip. */
	processMs: number | null;
	/** `store.put` of the processed JPEG. */
	storePutMs: number | null;
	/** The one `complete()` call: the model's read of the photo. */
	modelMs: number | null;
};

export const emptyTimings = (): PhotoTimings => ({
	processMs: null,
	storePutMs: null,
	modelMs: null
});

/** Whole milliseconds since `start` (a `performance.now()` reading); never negative. */
export const msSince = (start: number): number =>
	Math.max(0, Math.round(performance.now() - start));

/** Run `fn`, and record its duration in `timings[stage]` however it ends. */
export async function timed<T>(
	timings: PhotoTimings | undefined,
	stage: keyof PhotoTimings,
	fn: () => Promise<T>
): Promise<T> {
	const start = performance.now();
	try {
		return await fn();
	} finally {
		if (timings) timings[stage] = msSince(start);
	}
}
