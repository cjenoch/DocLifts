import { isIP } from 'node:net';

/**
 * The edge a deployment sits behind, declared explicitly.
 *
 * WHY A DECLARATION AND NOT AN INFERENCE
 * -------------------------------------
 * `CLIENT_IP_HEADER` says which header to read; it does not say whether the
 * deployment is actually behind the proxy that overwrites it. Nothing in the
 * process can tell the two apart: an unset header and an accidentally-unset
 * header look identical, and inferring "public origin therefore Cloudflare"
 * would impose Cloudflare semantics on every self-hosted install. So the
 * deployment states its position and the app checks the pair agrees.
 *
 *   DOCLIFTS_TRUSTED_EDGE=cloudflare  ->  CLIENT_IP_HEADER must be
 *                                         cf-connecting-ip, the only header
 *                                         cloudflared guarantees to overwrite.
 *   DOCLIFTS_TRUSTED_EDGE=none        ->  CLIENT_IP_HEADER must be unset.
 *   unset / empty                     ->  Undeclared. The legacy behaviour
 *                                         (first X-Forwarded-For value)
 *                                         applies and no pairing is enforced,
 *                                         so development, tests and any install
 *                                         that has not declared an edge keep
 *                                         working unchanged.
 *
 * A mismatch is a THROW, not a warning. It is evaluated when `createAuth`
 * builds its options — auth.ts calls `createAuth` at module scope and
 * adapter-node imports that graph at boot — so a half-configured deployment
 * refuses to start instead of hashing a client-supplied address into the
 * sign-in throttle. `scripts/check-trusted-edge.sh` enforces the same rule
 * before Compose starts anything, so the two cannot disagree.
 */
export const TRUSTED_EDGES = ['cloudflare', 'none'] as const;
export type TrustedEdge = (typeof TRUSTED_EDGES)[number];

/** The header Cloudflare's connector always overwrites with the real client. */
export const CLOUDFLARE_EDGE_HEADER = 'cf-connecting-ip';

/** The declared edge, or null when the deployment has not declared one. */
export function trustedEdge(
	env: Record<string, string | undefined> = process.env
): TrustedEdge | null {
	const declared = env.DOCLIFTS_TRUSTED_EDGE?.trim().toLowerCase();
	if (!declared) return null;
	if (!(TRUSTED_EDGES as readonly string[]).includes(declared)) {
		throw new Error(
			`DOCLIFTS_TRUSTED_EDGE must be ${TRUSTED_EDGES.join(' or ')}, or unset — got '${declared}'`
		);
	}
	return declared as TrustedEdge;
}

/** Only use this header behind a proxy that overwrites it (the tunnel in production). */
export function clientIpHeader(env: Record<string, string | undefined> = process.env): string {
	const edge = trustedEdge(env);
	const header = env.CLIENT_IP_HEADER?.trim().toLowerCase();
	if (edge === 'cloudflare' && header !== CLOUDFLARE_EDGE_HEADER) {
		throw new Error(
			`DOCLIFTS_TRUSTED_EDGE=cloudflare requires CLIENT_IP_HEADER=${CLOUDFLARE_EDGE_HEADER} ` +
				`(got ${header ? `'${header}'` : 'nothing set'}). Cloudflare's connector is the only ` +
				'edge that overwrites that header; without it the sign-in throttle would trust an ' +
				'address the client supplied.'
		);
	}
	if (edge === 'none' && header) {
		throw new Error(
			`DOCLIFTS_TRUSTED_EDGE=none refuses CLIENT_IP_HEADER='${header}': the header would be ` +
				'trusted without a proxy that overwrites it. Clear CLIENT_IP_HEADER for a tailnet or ' +
				'direct deployment.'
		);
	}
	if (!header) return 'x-forwarded-for';
	if (!/^[a-z0-9-]+$/.test(header))
		throw new Error('CLIENT_IP_HEADER must be one HTTP header name');
	return header;
}

/**
 * The pair is validated at IMPORT, not only when `clientIpHeader()` is called.
 *
 * WHY BOTH ARE NEEDED
 * -------------------
 * `clientIpHeader()` is called from the object literal `createAuth` returns. In
 * the BUNDLED server that property read is deferred: Rollup turns a property
 * whose initializer has side effects into a getter, so `advanced.ipAddress` was
 * read on the first request rather than at construction. Measured in an isolated
 * production image (2026-10-23): with `DOCLIFTS_TRUSTED_EDGE=cloudflare` and no
 * `CLIENT_IP_HEADER` the process started, listened, and answered **500** to
 * every request — including `/health` — instead of refusing to start. Fail
 * closed either way, but not the failure anybody reading this module expects.
 *
 * This module is imported on every server boot path (`auth-core` imports it for
 * `clientIpHeader`; `hooks.server.ts` imports `auth`), and a top-level call is
 * not deferred, so the throw now happens at boot. The per-call check stays as
 * the thing that covers a caller who builds its own env record.
 */
export function assertClientIpConfiguration(
	env: Record<string, string | undefined> = process.env
): void {
	// The return value is irrelevant: every rule lives in the checks.
	void clientIpHeader(env);
}

assertClientIpConfiguration();

/** IPv4 stays whole; IPv6 uses a canonical /64 network address, as Better Auth does. */
export function normalizeClientIp(value: string): string | null {
	const ip = value.trim();
	if (isIP(ip) === 4) return ip;
	if (isIP(ip) !== 6 || ip.includes('%')) return null;
	// URL canonicalization converts dotted IPv4 tails to hex and removes leading zeros.
	const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
	const [left, right] = canonical.split('::');
	const head = left ? left.split(':') : [];
	const tail = right ? right.split(':') : [];
	const groups = canonical.includes('::')
		? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
		: head;
	// IPv4-mapped addresses must share the IPv4 bucket, not one giant IPv6 bucket.
	if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
		const high = parseInt(groups[6], 16);
		const low = parseInt(groups[7], 16);
		return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
	}
	return [...groups.slice(0, 4), '0', '0', '0', '0'].map((g) => g.padStart(4, '0')).join(':');
}

export function clientIpFrom(
	headers: Headers,
	env: Record<string, string | undefined> = process.env
): string | null {
	const raw = headers.get(clientIpHeader(env));
	if (!raw) return null;
	// Legacy development/tailnet behavior only. A configured header is single-valued;
	// a missing, malformed or chained value never falls back to a client-supplied XFF.
	return normalizeClientIp(env.CLIENT_IP_HEADER?.trim() ? raw : raw.split(',')[0]);
}
