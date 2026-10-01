/**
 * Equipment model reads and the owned-row writes (spec 0.3.0 A3–A6).
 *
 * `equipment_models` holds two kinds of row (CLAUDE.md, "The one exception:
 * the global equipment catalog"): global catalog rows (owner_user_id IS NULL),
 * read-only to every user, and owned rows (owner_user_id = userId), user data.
 * Every read here goes through `modelVisibleTo`; every write targets an owned
 * row by putting `owner_user_id = userId` in its WHERE.
 */
import { eq, isNull, or, type SQL } from 'drizzle-orm';
import { equipmentModels } from './db/schema';

/**
 * The one visibility rule for models: global, or this user's own. Another
 * user's owned model is indistinguishable from a missing id (D6).
 */
export function modelVisibleTo(userId: string): SQL {
	return or(isNull(equipmentModels.ownerUserId), eq(equipmentModels.ownerUserId, userId))!;
}
