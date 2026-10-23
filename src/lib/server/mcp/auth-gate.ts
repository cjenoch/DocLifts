import { tokenHash } from './config';
import { clientIpFrom } from '../client-ip';

/** Bound work before token lookup. Cached denials never authorize a request;
 * successful tokens are revalidated on every request so revocation stays immediate.
 */
export class McpAuthGate {
	private readonly active = new Map<string, number>();
	private readonly invalid = new Map<string, number>();
	constructor(private readonly now = () => Date.now()) {}

	enter(
		headers: Headers
	): { release: () => void; denied: (invalid: boolean) => void } | 'invalid' | 'busy' {
		const key = clientIpFrom(headers) ?? 'unknown';
		const authorization = headers.get('authorization') ?? '';
		const tag = tokenHash(authorization);
		const now = this.now();
		for (const [hash, until] of this.invalid) if (until <= now) this.invalid.delete(hash);
		if (this.invalid.has(tag)) return 'invalid';
		if ((this.active.get(key) ?? 0) >= 2) return 'busy';
		this.active.set(key, (this.active.get(key) ?? 0) + 1);
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				const count = (this.active.get(key) ?? 1) - 1;
				if (count) this.active.set(key, count);
				else this.active.delete(key);
			},
			denied: (invalid) => {
				if (!invalid) return;
				// A small FIFO negative cache, never a growing list of attacker tokens.
				if (this.invalid.size >= 1000) this.invalid.delete(this.invalid.keys().next().value!);
				this.invalid.set(tag, this.now() + 5000);
			}
		};
	}
}
