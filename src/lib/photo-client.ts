/**
 * Resize on the phone before upload (0.5.0 Part A).
 *
 * The browser shrinks a camera photo before the POST, so a 3-5 MB photo goes
 * over the network as a few hundred KB. It is a SPEED-UP ONLY: the server
 * still validates, orients, resizes to 1600 px, re-encodes and strips every
 * upload (`src/lib/server/photos/process.ts`) and trusts nothing done here.
 *
 * `photoClientSettings` is the whole configuration. Change a number here and
 * nowhere else; no value below is repeated in the app. `enabled: false`
 * sends every photo exactly as it was chosen.
 */
export const photoClientSettings = {
	/** false: send the original file untouched. */
	enabled: true,
	/** Longest edge after resizing, in pixels. Never upscaled. */
	maxEdgePx: 2000,
	/** Canvas JPEG quality, 0 to 1. */
	jpegQuality: 0.88,
	/** Files smaller than this are sent as they are. */
	skipBelowBytes: 700_000,
	/** Give up resizing after this and send the original. */
	timeoutMs: 4000,
	/**
	 * The upload button's label while a photo is on its way. `preparing`:
	 * while it is resized here. `uploading`: from the POST until the review
	 * page, which covers the upload and the model's read. `failed`: when it
	 * never got there.
	 */
	labels: {
		preparing: 'Preparing photo',
		uploading: 'Identifying machine…',
		/** Shown when the upload never reached the server (dropped Wi-Fi, a 5xx):
		 * the form and the chosen photo stay, so trying again is one tap. */
		failed: "The photo didn't go through. Check your connection and tap Upload again."
	}
};

export type PhotoClientSettings = typeof photoClientSettings;

/**
 * The size to draw a `width` x `height` image at so its longer edge is at
 * most `maxEdgePx`, keeping the aspect ratio. Null when it already fits:
 * nothing is ever upscaled. Each side is at least 1 px.
 */
export function targetSize(
	width: number,
	height: number,
	maxEdgePx: number
): { width: number; height: number } | null {
	const longest = Math.max(width, height);
	if (!(longest > maxEdgePx) || !(maxEdgePx > 0)) return null;
	const scale = maxEdgePx / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

const jpegName = (name: string) => (name.replace(/\.[^./\\]*$/, '') || 'photo') + '.jpg';

async function shrink(file: File, s: PhotoClientSettings): Promise<File> {
	// Orientation is applied while decoding, so the canvas holds the photo
	// upright and the JPEG it writes needs no EXIF tag (it has none).
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	try {
		const size = targetSize(bitmap.width, bitmap.height, s.maxEdgePx);
		if (!size) return file;
		const canvas = document.createElement('canvas');
		canvas.width = size.width;
		canvas.height = size.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return file;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, 0, 0, size.width, size.height);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/jpeg', s.jpegQuality)
		);
		// No blob, the wrong type (a browser that cannot write JPEG falls back
		// to PNG), or no saving: the original is the better upload.
		if (!blob || blob.type !== 'image/jpeg' || blob.size >= file.size) return file;
		return new File([blob], jpegName(file.name), {
			type: 'image/jpeg',
			lastModified: file.lastModified
		});
	} finally {
		bitmap.close();
	}
}

/**
 * The file to upload in place of `file`: a JPEG within `maxEdgePx`, or `file`
 * itself. `settings` overrides `photoClientSettings` for this call only.
 *
 * Never throws and never rejects. Any failure — a format the browser cannot
 * decode, a missing API, a canvas that will not export, or `timeoutMs`
 * passing — returns the original, so the server's own checks and messages
 * (HEIC included) still apply to it.
 */
export async function resizeForUpload(
	file: File,
	settings: Partial<PhotoClientSettings> = {}
): Promise<File> {
	const s = { ...photoClientSettings, ...settings };
	if (!s.enabled || file.size < s.skipBelowBytes) return file;
	if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<File>((resolve) => {
		timer = setTimeout(() => resolve(file), s.timeoutMs);
	});
	try {
		return await Promise.race([shrink(file, s).catch(() => file), timeout]);
	} finally {
		clearTimeout(timer);
	}
}
