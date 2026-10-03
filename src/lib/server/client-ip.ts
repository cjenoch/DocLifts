import { isIP } from 'node:net';

/** Only use this header behind a proxy that overwrites it (the tunnel in production). */
export function clientIpHeader(env: Record<string, string | undefined> = process.env): string {
	const header = env.CLIENT_IP_HEADER?.trim().toLowerCase();
	if (!header) return 'x-forwarded-for';
	if (!/^[a-z0-9-]+$/.test(header))
		throw new Error('CLIENT_IP_HEADER must be one HTTP header name');
	return header;
}

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
