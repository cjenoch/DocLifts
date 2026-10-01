/**
 * Per-user LLM usage since a point in time, for the future quota work.
 * Read from `llm_calls`, so it survives restarts (unlike the in-memory cap).
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { llmCalls } from '../db/schema';
import type { Database } from '../progression';

export type LlmUsage = {
	/** Every recorded call, whatever its status. */
	calls: number;
	/** Calls refused before reaching the provider (cap or not configured). */
	refused: number;
	promptTokens: number;
	completionTokens: number;
};

export async function usageForUser(db: Database, userId: string, since: Date): Promise<LlmUsage> {
	const [row] = await db
		.select({
			calls: sql<number>`count(*)::int`,
			refused: sql<number>`count(*) filter (where ${llmCalls.status} = 'refused')::int`,
			promptTokens: sql<number>`coalesce(sum(${llmCalls.promptTokens}), 0)::int`,
			completionTokens: sql<number>`coalesce(sum(${llmCalls.completionTokens}), 0)::int`
		})
		.from(llmCalls)
		.where(and(eq(llmCalls.userId, userId), gte(llmCalls.createdAt, since)));
	return row;
}
