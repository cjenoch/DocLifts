import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/request-user';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { verifyPasswordViaHandler } from '$lib/server/auth-proxy';
import {
	readAccountExport,
	hasExportSession,
	ExportAccessError,
	ExportLimitError,
	MAX_EXPORT_BYTES
} from '$lib/server/exports/data';
import { jsonArchive, spreadsheetArchive, strongCsv } from '$lib/server/exports/formats';
import { enterExport } from '$lib/server/exports/admission';
import type { RequestHandler } from './$types';

const formSchema = z
	.object({
		format: z.enum(['json', 'csv', 'strong']),
		password: z.string().min(1).max(128),
		timeZone: z.string().min(1).max(80)
	})
	.strict();
async function boundedForm(request: Request) {
	if (
		request.headers.get('content-type')?.split(';')[0].trim() !==
		'application/x-www-form-urlencoded'
	)
		error(415, 'Use the export form.');
	const reader = request.body?.getReader();
	if (!reader) error(400, 'Missing export form.');
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		void reader.cancel().catch(() => {});
	}, 5000);
	const deadline = Date.now() + 5000;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (Date.now() >= deadline) {
				expired = true;
				break;
			}
			if (done) break;
			bytes += value.length;
			if (bytes > 8192) error(413, 'Export form is too large.');
			chunks.push(value);
		}
	} finally {
		clearTimeout(timer);
		await reader.cancel().catch(() => {});
	}
	if (expired) error(408, 'Export form timed out. Try again.');
	const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
	if ([...fields.keys()].length !== new Set(fields.keys()).size)
		error(400, 'Repeated export fields.');
	const parsed = formSchema.safeParse(Object.fromEntries(fields));
	if (!parsed.success) error(400, 'Choose a format and enter your current password.');
	try {
		new Intl.DateTimeFormat('en', { timeZone: parsed.data.timeZone });
	} catch {
		error(400, 'Choose a valid time zone, such as America/New_York or UTC.');
	}
	return parsed.data;
}
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals);
	const input = await boundedForm(request);
	const verified = await verifyPasswordViaHandler(request.headers, input.password);
	if (!verified.ok)
		error(
			verified.status === 429 ? 429 : 400,
			verified.status === 429
				? 'Too many password attempts. Wait a minute and try again.'
				: 'Your password could not be verified. Go back and check your current password.'
		);
	const session = await auth.api.getSession({ headers: request.headers });
	if (
		!session ||
		session.user.id !== user.id ||
		!(await hasExportSession(db, user.id, session.session.id))
	)
		error(401, 'Your session ended. Sign in again.');
	const leave = enterExport(user.id);
	if (!leave)
		return new Response('An export is already running. Go back and try again shortly.', {
			status: 429,
			headers: { 'retry-after': '5', 'content-type': 'text/plain; charset=utf-8' }
		});
	try {
		const data = await readAccountExport(db, user.id);
		const now = new Date();
		const body =
			input.format === 'json'
				? Buffer.from(JSON.stringify(jsonArchive(data, now), null, 2) + '\n')
				: input.format === 'csv'
					? Buffer.from(spreadsheetArchive(data, now))
					: Buffer.from(strongCsv(data, input.timeZone));
		if (body.length > MAX_EXPORT_BYTES)
			throw new ExportLimitError('Export exceeds the size limit.');
		if (!(await hasExportSession(db, user.id, session.session.id)))
			error(401, 'Your session ended. Sign in again.');
		const ext = input.format === 'json' ? 'json' : input.format === 'csv' ? 'zip' : 'csv';
		const kind =
			input.format === 'strong' ? 'strong-kg' : input.format === 'csv' ? 'spreadsheets' : 'account';
		return new Response(body, {
			headers: {
				'content-type':
					input.format === 'json'
						? 'application/json; charset=utf-8'
						: input.format === 'csv'
							? 'application/zip'
							: 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="doclifts-${kind}-${now.toISOString().slice(0, 10)}.${ext}"`,
				'content-length': String(body.length),
				'cache-control': 'private, no-store',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (cause) {
		if (cause instanceof ExportLimitError)
			error(
				413,
				'This account is too large for an immediate export (50,000 records / 32 MiB). Contact support@runthe.ai for a complete export. No partial file was produced.'
			);
		if (cause instanceof ExportAccessError)
			error(401, 'Your account is unavailable. Sign in again.');
		throw cause;
	} finally {
		leave();
	}
};
