# DocLifts MCP — Alpha 0.16.1 specification

Status: 0.16.0 rolled back after a missing acceptance-test credential file.
0.16.1 changes the deployment checks only; retry awaits owner approval.
Production is restored to 0.15.2 Alpha; the MCP hostname is not active.

## Outcome and first scope

A user connects their own agent to https://doclifts-mcp.runthe.ai/mcp, signs in
at DocLifts, reviews named permissions, and can revoke the connection from
Account → Connected agents. On a 390 px phone the consent and revoke controls
remain reachable without horizontal scrolling. MCP never asks an agent for a
DocLifts password. Signup stays closed.

Streamable HTTP with stateless JSON responses, using the official TypeScript
SDK 1.32.0. Six tools: list_workouts, get_workout, list_programs, get_program,
list_equipment, get_data_dictionary. No write, SQL, shell, model, URL-fetch,
photo, pain-record or administration tool. Richer complete native archive/CSV
export and note scribing remain later features; these reads are not a backup.

## Identity and consent

Better Auth OAuth Provider 1.7.7, paired with Better Auth 1.7.7. Authorization code
with S256 PKCE and rotating refresh tokens. No client-credentials/password grant.
Resource is the exact MCP URL; issuer is the main app's /api/auth URL. Discovery
is served at canonical protected-resource and authorization-server metadata paths.
Dynamic client registration supports current clients; CIMD is not implemented in
this Alpha. OAuth metadata advertises supported mechanisms, no invented support.

Scopes: workouts:read, programs:read, equipment:read; notes:read separately
requested and displayed. offline_access permits refresh for up to 30 days. Access
tokens last 15 minutes and are opaque, hashed with SHA256 at rest. Both initial
request and tool execution check current token expiry, resource, account session,
client enabled state and consent. Revoking from the app deletes that user's
consent, access tokens and refresh tokens for the client; other users untouched.
Stored tokens and browser session cookies never appear in responses or logs.

Signed consent query verified by the provider helper; tampering/expiry rejected.
User sees account, client name/id and requested scopes before the first grant.
The provider may reuse an existing consent for already approved access. A signed
public continuation resumes the OAuth request after login; the sign-in form now
preserves its validated same-origin return path. A same-origin completion page
navigates to the library-validated callback, with a link for browsers without JS;
this preserves CSP form-action self across the OAuth return.

SvelteKit's built-in global form-origin check cannot exempt the native OAuth token
endpoint and executes before hooks. This release replaces that global check with
`csrfBoundary`, ahead of Better Auth and all page actions. It retains same-origin
checks for form-encoded POST/PUT/PATCH/DELETE requests, except an exact POST to
/api/auth/oauth2/token with form encoding, NO Cookie header and NO Origin header.
That exception authenticates through PKCE/refresh credentials, never cookies.
Better Auth's own origin and CSRF checks remain enabled. This is an explicit
security-boundary change requiring owner diff review; browser/form tests verify
that missing/forged origins, cookies and lookalike paths remain refused.

## Read semantics and limits

Account identity comes only from the verified token. Every query includes its
ownership chain and runs in a READ ONLY, repeatable-read transaction with a 5-second SQL
timeout. UUID cursors, 1–50 rows per page, no arbitrary filtering or query syntax.
Workouts exclude Trash. Programs retain lineage and inactive versions. Equipment
identifies the physical instance and includes archive state. Units, conventions,
nulls, prescribed versus executed values and seconds targets are documented in
the dictionary. Do not infer a performed set from logged_at alone.

Explicit field lists exclude credentials, internal audits and personal notes
unless separately scoped. All names/notes are untrusted text; no HTML rendering,
URL fetching, or instructions derived from returned data. No write tools means a
malicious stored note cannot authorize a database mutation through this server.
The receiving agent still needs its own prompt-injection defenses.

Limits: 32 KiB request body including chunked requests, 256 KiB tool result, 8 in-flight
requests, 60 requests/user/minute, bounded 1000-user counter map, 10-second total body-read deadline.
Counters are process-local; a second replica requires shared limits. Metadata
logs only hashed account, tool name, elapsed time and outcome. Private no-store
responses. No model calls or new provider spend.

## VPS and tunnel

First release shares the existing hardened DocLifts web runtime and database
pool; it does not expose Postgres or add a public host port. Read-only transactions
are enforced, but this is not a separately privileged database role/process. A
future standalone worker can add that isolation while reusing scoped read code.

Cloudflare Tunnel ingress on doclifts-mcp.runthe.ai forwards only /mcp and the
protected-resource metadata routes to web:3000; all other paths at that hostname
return 404. Login/consent/OAuth endpoints stay on doclifts.runthe.ai with host-only
cookies. No cookie sharing or Better Auth trusted-origin expansion. The narrowly scoped
form-origin boundary change above is part of the review.
Apply the reviewed DNS/ingress/header/cache changes only after the release gate,
fresh restored backup and owner review. Keep the previous web image until
acceptance. On failed production checks roll back and report; no automatic retry.

Migration 0020 adds OAuth control-plane tables under auth, not workout data. It
must be applied and constraint/count-verified on a fresh restored production
backup before production. Unmerged signup work also used 0020 and must regenerate
its migration against this main before merging; never rename an applied file.

## Compatibility and acceptance

Targets: Claude/Claude Code, ChatGPT, Hermes, Muse, Google agent tooling. Generic
SDK interoperability is required; each real client's OAuth/discovery support is
verified individually, not inferred from a logo. Client-specific configuration
and callbacks must come from official docs or the installed client's behavior.
Actual account connection needs the owner's interactive consent in each client.

Acceptance includes real browser login/allow/deny/revoke, SDK initialize/list/call,
wrong/missing/expired/revoked tokens, PKCE/resource/redirect/scope negatives,
positive-own then foreign-account reads for every data path, note opt-in,
pagination/body/output limits, unchanged training rows, strict CSP/390 px layout,
full local and exact-head CI gates, fresh restored migration, and public tunnel
checks with scratch/test accounts only. Prior image-safety injection findings
remain open; MCP is read-only and does not fix the vision model prompt.

## Initial client setup

After deployment, use `https://doclifts-mcp.runthe.ai/mcp` as the remote Streamable
HTTP server URL and OAuth as the authentication method. Never supply a DocLifts
password as a tool argument or copy an app session cookie into an agent.

Hermes supports a remote server entry with `url` and `auth: oauth`; its browser
flow grants access and its OAuth store refreshes it. Google Gemini CLI supports
remote HTTP MCP and OAuth discovery. Muse Code documents HTTP transport and
`muse mcp login`; confirm which Muse application is being connected before using
client-specific commands. These are documented capabilities, not a claim that
these client connections have been completed. Claude and ChatGPT likewise remain
individual client acceptance checks after the generic SDK and tunnel checks.

- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/mcp-config-reference.md
- https://geminicli.com/docs/tools/mcp-server/
- https://meta-models.github.io/muse-code-sdk/next/guides/extend/mcp-servers/

## References

- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://ts.sdk.modelcontextprotocol.io/
- https://better-auth.com/docs/plugins/oauth-provider
