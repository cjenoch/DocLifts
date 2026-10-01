/**
 * What `llm_calls` records about a prompt.
 *
 * `prompt_hash` is always written: the first 16 hex of sha256 over a canonical
 * serialization of the instructions and messages, enough to tell "the same
 * prompt" from "a different one" without storing it. `prompt_text` is written
 * only with LLM_STORE_PROMPTS=1, and even then image bytes are never stored —
 * each image is replaced by its own sha256, so a stored prompt is text only.
 */
import { createHash } from 'node:crypto';
import type { ImagePart, TextPart } from 'ai';

export type LlmMessage =
	| { role: 'user'; content: string | Array<TextPart | ImagePart> }
	| { role: 'assistant'; content: string | Array<TextPart> };

const sha256 = (data: string | Uint8Array): string =>
	createHash('sha256').update(data).digest('hex');

function describeImage(image: ImagePart['image']): string {
	if (image instanceof URL) return image.href;
	if (typeof image === 'string') {
		return /^https?:\/\//i.test(image) ? image : `sha256:${sha256(image)}`;
	}
	if (image instanceof Uint8Array) return `sha256:${sha256(image)}`;
	if (image instanceof ArrayBuffer) return `sha256:${sha256(new Uint8Array(image))}`;
	// A provider reference from uploadFile: an opaque id, safe to keep.
	return `ref:${JSON.stringify(image)}`;
}

function canonical(system: string, messages: readonly LlmMessage[]): string {
	return JSON.stringify({
		system,
		messages: messages.map((m) => ({
			role: m.role,
			content:
				typeof m.content === 'string'
					? m.content
					: m.content.map((part) =>
							part.type === 'text'
								? { type: 'text', text: part.text }
								: {
										type: 'image',
										mediaType: part.mediaType ?? null,
										image: describeImage(part.image)
									}
						)
		}))
	});
}

/** First 16 hex of sha256 over the canonical prompt. */
export function promptHash(system: string, messages: readonly LlmMessage[]): string {
	return sha256(canonical(system, messages)).slice(0, 16);
}

/** The canonical prompt as stored when LLM_STORE_PROMPTS=1 (images as hashes). */
export function promptText(system: string, messages: readonly LlmMessage[]): string {
	return canonical(system, messages);
}
