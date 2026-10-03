import { createHash } from 'node:crypto';
export const MCP_SCOPES = [
	'workouts:read',
	'programs:read',
	'equipment:read',
	'notes:read'
] as const;
export const MCP_SCOPE_LABELS: Record<string, string> = {
	'workouts:read': 'Read workouts and logged sets',
	'programs:read': 'Read programs and prescribed sets',
	'equipment:read': 'Read gyms, exercises and machine details',
	'notes:read': 'Include your written notes (may contain health information)'
};
export function mcpResource() {
	return process.env.MCP_RESOURCE_URL || 'https://doclifts-mcp.runthe.ai/mcp';
}
export function tokenHash(token: string) {
	return createHash('sha256').update(token).digest('hex');
}
