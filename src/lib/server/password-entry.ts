import { clientIpFrom } from './client-ip';
import {
	checkLoginThrottle,
	clearLoginFailures,
	loginThrottle,
	nextLoginDelayMs,
	recordLoginFailure,
	type LoginThrottle,
	type ThrottleKeyType
} from './login-throttle';

export type LoginWait = { heldMs: number; nextDelayMs: number; keyType?: ThrottleKeyType };
const waits = new WeakMap<Response, LoginWait>();
export const loginWaitFor = (response: Response): LoginWait =>
	waits.get(response) ?? { heldMs: 0, nextDelayMs: 0 };

/** One credential boundary for the public JSON endpoint and server-side form proxy.
 * State is local to the process, like LoginThrottle. No client header bypasses it.
 * Only IP owns a concurrency lane: an email must never become an account lock.
 * A lane covers the sleep AND password verification; excess requests never queue.
 */
export function passwordEntryHandler(
	handler: (request: Request) => Promise<Response>,
	throttle: LoginThrottle = loginThrottle
): (request: Request) => Promise<Response> {
	const active = new Set<string>();
	return async (request) => {
		let path: string;
		try {
			path = decodeURIComponent(new URL(request.url).pathname).replace(/\/+$/, '');
		} catch {
			return new Response(null, { status: 400 });
		}
		if (request.method !== 'POST' || path !== '/api/auth/sign-in/email') return handler(request);
		// Missing IP shares one bounded fallback lane; never silently skip protection.
		const ip = clientIpFrom(request.headers);
		const lane = ip ?? 'unknown';
		if (active.has(lane))
			return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
		if (active.size >= 32)
			return new Response(null, { status: 503, headers: { 'retry-after': '1' } });
		active.add(lane);
		try {
			const mediaType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
			if (mediaType !== 'application/json' && mediaType !== 'application/x-www-form-urlencoded')
				return Response.json(
					{ code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use JSON or URL-encoded form data.' },
					{ status: 415 }
				);
			// Bound the body before parsing it, including slow/chunked requests. Do not
			// clone a live stream: its unread branch would buffer outside this bound.
			const reader = request.body?.getReader();
			const parts: Uint8Array[] = [];
			let size = 0;
			const deadline = Date.now() + 10_000;
			try {
				if (reader)
					while (true) {
						let timer: ReturnType<typeof setTimeout> | undefined;
						const chunk = await Promise.race([
							reader.read(),
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(new Error('body_timeout')),
									Math.max(0, deadline - Date.now())
								);
							})
						]).finally(() => clearTimeout(timer));
						if (chunk.done) break;
						size += chunk.value.length;
						if (size > 32_768) return new Response(null, { status: 413 });
						parts.push(chunk.value);
					}
			} catch {
				return new Response(null, { status: 408 });
			} finally {
				if (reader) {
					void reader.cancel().catch(() => {});
					reader.releaseLock();
				}
			}
			const raw = Buffer.concat(parts).toString();
			request = new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: raw
			});
			let body: unknown;
			try {
				// Use Fetch's own decoding, exactly as Better Call does. Its URL-encoded
				// parser keeps the LAST duplicate key; JSON decoding also strips a UTF-8 BOM.
				body =
					mediaType === 'application/json'
						? await request.clone().json()
						: Object.fromEntries(await request.clone().formData());
			} catch {
				return Response.json(
					{ code: 'BAD_REQUEST', message: 'Invalid sign-in body.' },
					{ status: 400 }
				);
			}
			if (!body || typeof body !== 'object' || !('email' in body) || typeof body.email !== 'string')
				return Response.json(
					{ code: 'BAD_REQUEST', message: 'An email is required.' },
					{ status: 400 }
				);
			const keys = { ip: lane, email: body.email };
			const decision = await checkLoginThrottle(throttle, keys);
			if (decision.kind === 'busy') {
				return new Response(null, {
					status: 503,
					headers: { 'retry-after': String(decision.retryAfterSeconds) }
				});
			}
			if (decision.kind === 'refuse') {
				const response = new Response(null, {
					status: 429,
					headers: { 'retry-after': String(decision.retryAfterSeconds) }
				});
				waits.set(response, { heldMs: 0, nextDelayMs: 0, keyType: decision.keyType });
				return response;
			}
			const response = await handler(request);
			if (response.status === 401) recordLoginFailure(throttle, keys);
			else if (response.ok) clearLoginFailures(throttle, keys);
			waits.set(response, {
				heldMs: decision.kind === 'delay' ? decision.delayMs : 0,
				nextDelayMs: nextLoginDelayMs(throttle, keys),
				keyType: decision.kind === 'delay' ? decision.keyType : undefined
			});
			return response;
		} finally {
			active.delete(lane);
		}
	};
}
