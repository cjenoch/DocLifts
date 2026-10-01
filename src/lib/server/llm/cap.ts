/**
 * Per-user hourly call cap. Same shape as the login throttle
 * (login-throttle.ts): an in-process `Map<key, number[]>` of timestamps over a
 * sliding window, pruned on read, with an injectable clock so tests never wait.
 *
 * Its limits are the throttle's limits, for the same reasons: a restart clears
 * every counter, and a second replica would get its own empty map (the
 * effective limit becomes N x the setting). Before a second replica, move this
 * to a query over `llm_calls` — the rows are already there.
 *
 * Only calls that are sent to the provider are counted. A refused call is not:
 * counting refusals would let a loop that keeps asking keep itself refused
 * forever, and a refused call costs nothing.
 */

export type Clock = () => number;

export const CAP_WINDOW_MS = 60 * 60 * 1000;

export class LlmCallCap {
	private readonly calls = new Map<string, number[]>();

	constructor(private readonly clock: Clock = () => Date.now()) {}

	private live(userId: string): number[] {
		const cutoff = this.clock() - CAP_WINDOW_MS;
		const live = (this.calls.get(userId) ?? []).filter((at) => at > cutoff);
		if (live.length === 0) this.calls.delete(userId);
		else this.calls.set(userId, live);
		return live;
	}

	/** True when one more call fits under `limit` in the last hour. */
	allows(userId: string, limit: number): boolean {
		return this.live(userId).length < limit;
	}

	/** Count a call that is about to be sent. */
	record(userId: string): void {
		const live = this.live(userId);
		live.push(this.clock());
		this.calls.set(userId, live);
	}
}
