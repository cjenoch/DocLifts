/**
 * The photo upload log line (0.5.0 Part A): one JSON line per upload, so the
 * effect of resizing on the phone can be measured from the server log.
 *
 * `clientOriginalBytes` and `clientResized` are what the browser SAYS it did.
 * They are measurement only and never trusted: parsed defensively here, and
 * used for nothing but this line. Validation and storage read the received
 * file alone. A missing or malformed value is logged as null.
 */

export type ClientMeasurement = {
	clientOriginalBytes: number | null;
	clientResized: boolean | null;
};

/** Larger than any upload the body limit could let through; anything above is noise. */
const MAX_REPORTED_BYTES = 1_000_000_000;

export function clientMeasurement(form: FormData): ClientMeasurement {
	const bytes = form.get('clientOriginalBytes');
	const resized = form.get('clientResized');
	const n = typeof bytes === 'string' && /^\d{1,10}$/.test(bytes) ? Number(bytes) : NaN;
	return {
		clientOriginalBytes: Number.isSafeInteger(n) && n <= MAX_REPORTED_BYTES ? n : null,
		clientResized: resized === '1' ? true : resized === '0' ? false : null
	};
}

export type UploadLogLine = ClientMeasurement & {
	event: 'photo_upload';
	/** The bytes that actually arrived. */
	receivedBytes: number;
	outcome: 'stored' | 'refused';
	/** The stored image's size and id, when stored. */
	storedBytes: number | null;
	photoId: string | null;
};

/** Deliberately console.log(JSON): one greppable line, like the login attempt log. */
export function logUpload(line: Omit<UploadLogLine, 'event'>): void {
	console.log(JSON.stringify({ event: 'photo_upload', ...line } satisfies UploadLogLine));
}
