/**
 * How the photo routes answer a refusal. Every refusal the user can act on is
 * a message on the page (a 400 in the action envelope), not a throttle; a
 * configuration problem is a 503 with its variable NAMES in the server log.
 */
import { PhotoSafetyError } from './safety';
import { fail } from '@sveltejs/kit';
import { PhotoConfigError } from './config';
import { PhotoInputError } from './process';
import { PhotoLimitError } from './index';

export function photoFailure(e: unknown) {
	if (e instanceof PhotoSafetyError)
		return fail(e.reason === 'blocked' ? 400 : 503, { message: e.message });
	if (e instanceof PhotoInputError || e instanceof PhotoLimitError) {
		return fail(400, { message: e.message });
	}
	if (e instanceof PhotoConfigError) {
		console.error(`[photos] ${e.message}`);
		return fail(503, { message: 'Photo storage is not set up on this server yet.' });
	}
	throw e;
}
