import { eq, and, ne } from 'drizzle-orm';
import { photoNoticeAcknowledgements } from './db/schema';
import type { Database } from './progression';
import { PHOTO_NOTICE_VERSION, PHOTO_NOTICE_REQUIRED } from '$lib/photo-privacy';

export async function hasPhotoNotice(db: Database, userId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: photoNoticeAcknowledgements.userId })
		.from(photoNoticeAcknowledgements)
		.where(
			and(
				eq(photoNoticeAcknowledgements.userId, userId),
				eq(photoNoticeAcknowledgements.version, PHOTO_NOTICE_VERSION)
			)
		);
	return !!row;
}
export async function acknowledgePhotoNotice(db: Database, userId: string) {
	await db
		.insert(photoNoticeAcknowledgements)
		.values({ userId, version: PHOTO_NOTICE_VERSION })
		.onConflictDoUpdate({
			target: photoNoticeAcknowledgements.userId,
			set: { version: PHOTO_NOTICE_VERSION, acknowledgedAt: new Date() },
			setWhere: ne(photoNoticeAcknowledgements.version, PHOTO_NOTICE_VERSION)
		});
}

export class PhotoNoticeRequired extends Error {
	constructor() {
		super(PHOTO_NOTICE_REQUIRED);
		this.name = 'PhotoNoticeRequired';
	}
}
export async function requirePhotoNotice(db: Database, userId: string) {
	if (!(await hasPhotoNotice(db, userId))) throw new PhotoNoticeRequired();
}
