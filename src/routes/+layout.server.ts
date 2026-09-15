import { env } from '$env/dynamic/private';

export function load() {
	return { demoMode: env.DOCLIFTS_DEMO === '1' };
}
