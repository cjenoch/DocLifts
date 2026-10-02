/** Types for scripts/audit-summary.mjs (a plain Node script CI runs without a build). */
export declare const SEVERITY_ORDER: readonly string[];
export declare const FAIL_AT: string;
export declare function summarize(audit: unknown): string;
