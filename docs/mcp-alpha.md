# DocLifts MCP — Alpha 0.16.4 specification

Status: **0.16.4 Alpha is live**, runtime `12e1caf`. Public SDK checks passed for
bulk/imported reads, pagination, notes excluded/included by consent, refresh and
revocation. The **Muse chat app** has successfully called the imported-history and
bulk-set tools, and its user-approved grant includes notes:read. This confirms
actual client access, not complete pagination or correctness of its analysis.
Other clients remain individual compatibility checks. Release history is in the
[changelog](../CHANGELOG.md) and [deployment log](release-0.2.0.md).

## Outcome and first scope

A user connects their own agent to https://doclifts-mcp.runthe.ai/mcp, signs in
at DocLifts, reviews named permissions, and can revoke the connection from
Account → Connected agents. On a 390 px phone the consent and revoke controls
remain reachable without horizontal scrolling. MCP never asks an agent for a
DocLifts password. Signup stays closed.

Streamable HTTP with stateless JSON responses, using the official TypeScript
SDK 1.32.0. Eight tools: list_workouts, list_workout_sets, get_workout, list_imported_workouts, list_programs,
get_program, list_equipment, get_data_dictionary. No write, SQL, shell, model, URL-fetch,
photo, pain-record or administration tool. Richer complete native archive/CSV
export and note scribing remain later features; these reads are not a backup.

## Identity and consent

Better Auth OAuth Provider 1.7.7, paired with Better Auth 1.7.7. Authorization code
with S256 PKCE and rotating refresh tokens. No client-credentials/password grant.
Resource is the exact MCP URL; issuer is the main app's /api/auth URL.
For clients that omit resource, the 0.16.2 authorization hook adds this single
resource before provider validation/signing. Explicit targets and signed
continuations are never rewritten. Consent and access-token checks still require
the exact audience; token exchange/refresh can inherit the bound resource. Discovery
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
security-boundary change approved by the owner; browser/form tests verify
that missing/forged origins, cookies and lookalike paths remain refused.

## Read semantics and limits

Account identity comes only from the verified token. Every query includes its
ownership chain and runs in a READ ONLY, repeatable-read transaction with a 5-second SQL
timeout. UUID cursors, 1–50 rows per page, no arbitrary filtering or query syntax.
Workouts exclude Trash. Programs retain lineage and inactive versions. Equipment
identifies the physical instance and includes archive state. Units, conventions,
nulls, prescribed versus executed values and seconds targets are documented in
the dictionary. Do not infer a performed set from logged_at alone.

`list_workout_sets` returns up to 50 set rows per call across app workouts, with
workout IDs/dates/program metadata and the same historical exercise/machine fields
as get_workout. It uses workouts:read, excludes Trash and preserves blank, zero
and timed values. Optional notes cover set and workout notes. from is inclusive
and to exclusive on session start; UUID cursor order is not chronological. Group
by workoutId and order by exercisePosition/position. list_workouts still provides
empty sessions. Cache pages and use this tool instead of one get_workout per
session when analyzing full history. The request/rate/output bounds are unchanged.

`list_imported_workouts` uses the existing workouts:read grant and returns whole
imported workouts with structured lines/sets, 20 by default and at most 50 per page.
Follow nextCursor to exhaustion. No date filter: uncertain/undated records remain
visible. UUID order is pagination order, not chronology. Source is explicitly
imported_notebook; app-session reads link to the archive tool so clients discover
both collections. They can overlap; never blindly combine totals. No training
rows are copied, changed or fed into progression by this read.

Imported workoutDate and date bounds are calendar dates, not UTC instants. Explicit
and user_authorized_estimate evidence, zeros and original load conventions survive.
Source text, dateNote and interpretationNote require notes:read; without it the
structured sets remain available but exercise labels may be unknown. The client
must request optional notes access through fresh consent to interpret that text.
No entire source documents, filenames, hashes or unknown JSON fields are returned,
even with notes scope. Text is untrusted, never agent instructions. Recorded values
are not independently verified training; missing sets do not prove no activity.
The existing 256 KiB response guard applies; reduce page size for unusually long
notebooks. A single oversized record is refused, never silently truncated.

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
fresh restored backup and the current owner-directed development policy. Retain
at least two previous web images. During this cycle, troubleshoot and fix forward
without routine reapproval or automatic rollback; report failures and recovery.

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

Use `https://doclifts-mcp.runthe.ai/mcp` as the remote Streamable
HTTP server URL and OAuth as the authentication method. Never supply a DocLifts
password as a tool argument or copy an app session cookie into an agent.

### Verified client and history retrieval

The tested Muse client is the **Meta chat app**, not Muse Code CLI. Its custom
connector asks for the MCP URL and an OAuth Client ID; the Client ID is an
application identifier, not the user's email or password. Use the exact callback
provided by the client when registering it. The Muse chat callback used in this
test was `https://agent.meta.ai/api/hatch/oauth/callback`.

Refreshing/reconnecting may be needed when a client caches the tool list. A
reconnect with only the original scopes does not add notes access: the client must
request notes:read, and the user must approve it. Never change stored consent or
tokens to bypass that flow.

Suggested instruction to a connected agent:

> Read get_data_dictionary. Fetch list_workouts for session metadata,
> list_workout_sets for bulk app sets, and list_imported_workouts for imported
> notebooks. Use limit50, follow nextCursor until null and cache completed pages.
> Respect Retry-After on429. Preserve source, units, uncertain dates and estimated
> evidence; do not infer exercise names when source text is unavailable or treat
> missing values as proof of no training. Request notes:read if original text is
> needed, and explain that permission to the user.

| Tool                   | Purpose                                              | Required scope       |
| ---------------------- | ---------------------------------------------------- | -------------------- |
| get_data_dictionary    | Units, conventions, sources and interpretation rules | Any valid connection |
| list_workouts          | App-session metadata, including empty sessions       | workouts:read        |
| list_workout_sets      | Bulk set rows with workout and historical context    | workouts:read        |
| get_workout            | One app workout with paginated set details           | workouts:read        |
| list_imported_workouts | Notebook workouts and structured sets in pages       | workouts:read        |
| list_programs          | Program versions and lineage                         | programs:read        |
| get_program            | Prescribed structure of one program                  | programs:read        |
| list_equipment         | Owned gyms and physical equipment instances          | equipment:read       |

Notes are an additional optional scope, not a ninth tool. Imported records are
workout → notebook lines → sets (load, reps, evidence), with date bounds and source
positions. They do not gain canonical exercise IDs merely by being read via MCP.

Generic SDK consent/read/refresh/revoke is verified. Hermes, Google agent tooling,
Claude and ChatGPT remain separate client acceptance work; support is not inferred
from generic protocol compatibility.

## References

- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://ts.sdk.modelcontextprotocol.io/
- https://better-auth.com/docs/plugins/oauth-provider

### App identity on consent

OAuth app names are self-supplied. DocLifts labels apps **Unverified app** and
shows the callback destination selected in the signed authorization request.
Check the complete host, scheme and any port; a familiar app name is not proof
of identity. This destination is where the connection returns, not a guarantee
about every service the app might later share data with. No verified-client
registry is currently maintained. Native app callbacks show their app URI
without query parameters; web callbacks show their origin.
