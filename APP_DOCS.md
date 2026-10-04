# DocLifts — application overview

Current through **0.17.0 Alpha**, October 4, 2026. DocLifts is a live multi-user
workout log at [doclifts.runthe.ai](https://doclifts.runthe.ai). Accounts own their
workouts, programs, gyms and machines. Alpha access is operator-managed; signup
remains closed. The sign-in leads with **Document your Lifts**.

## During a workout

The header offers Simple and Advanced views. Simple emphasizes weight, reps and
Save set, with notes and RIR one tap away. Advanced exposes effort and program
tools. Switching preserves saved values and unsaved entries; it does not change
progression. Each account has a separate preference in the current browser, with
an in-memory fallback when storage is blocked. Devices do not synchronize it.
Fresh accounts can explore starter programs, and the gym/empty-workout screens
provide a first-set guide. This is the first beginner UI pass, not full onboarding.

Choose an editable starter program or begin a quick workout. Photograph a machine
and record sets while identification runs. Review the match when ready; saved
sets survive identification and a failed model call does not block manual logging.
Repeat-machine recognition has a review/undo path.

Record load, repetitions or duration, RIR and optional notes. Add, move, remove,
skip or swap exercises during a session. “Just today” and “From now on” distinguish
a session change from a program change. Set entry includes machine-aware increments
and a rest timer. Browser drafts are not saved or synced records.

History and reports show recorded work; workouts can be edited and restored from
Trash. Missing values mean unknown, not zero. A populated Alpha test entry is not
independently verified performance.

## Programs, identity and progression

Programs contain ordered days, exercises and prescribed set structure. Editing a
program copies its version and children; past prescriptions remain snapshots.
Session-start copies the set role, target metric, rep range and RIR prescription.
The carefully gated machine-binding and live-swap exceptions are documented in
[project rules](CLAUDE.md) and [machine identity](docs/machine-identity.md).

Machine history follows the physical machine and load convention. Free-weight
history follows the exercise across gyms. Do not compare per-arm, per-side and
total loads without their recorded context. Timed sets use seconds, not repetition
volume.

Progression is deterministic and tier-aware: main work uses the top set;
secondary/isolation work requires all working positions to clear the target.
Warmups do not advance through the progression engine. Standard, cautious and hold
policies control suggestions. Equipment-aware plate calculations follow the
history/progression decision. The explanation accompanies the suggested load,
and the user can change it. Completed-history filters protect suggestions from
blank pre-created rows; the rules are specified in [CLAUDE.md](CLAUDE.md).

## Photos and AI

Uploads are rebuilt into cleaned images in memory, screened, and only then stored
or sent for identification. A rejection or scanner failure refuses the upload;
manual set logging remains available. Local and OpenRouter screeners support
controlled A/B testing. See [photo safety](docs/photo-safety.md).

Model requests pass through one interface for structured-output validation,
timeouts, per-user limits and usage records. The model suggests equipment identity;
it does not write executed set values. Content screening and prompt injection are
separate concerns. See [AI interface](docs/llm.md) and [photos](docs/photos.md).

## Imported notebooks and agent access

The imported archive preserves workout dates or date ranges, titles, gyms, source
lines, original text, load conventions and structured load/reps pairs. Sets retain
explicit or user-authorized-estimate evidence. It stays separate from app sessions
and does not drive current progression. There is no canonical exercise ID on a
notebook line; its original text is needed to interpret the exercise.

The live [MCP endpoint](https://doclifts-mcp.runthe.ai/mcp) provides eight read-only
tools. A user signs in, consents to named account permissions and may revoke the
connection. Notebook text and written notes require optional notes:read. Agents
receive bounded data responses, not database credentials or arbitrary SQL access.

For history analysis, list_workouts supplies session metadata (including empty
sessions), list_workout_sets supplies bulk contextual set rows, and
list_imported_workouts supplies notebook workouts with their structured sets.
Use limit50 and follow nextCursor. Read get_data_dictionary first: keep estimates,
uncertain dates and test/incomplete entries visible, and do not double-count
potentially overlapping collections. The Muse chat app has successfully read both
collections. Other clients require individual verification.

See [MCP setup, permissions and semantics](docs/mcp-alpha.md). These reads are not
a complete database backup or a portable restore format. Self-service notebook
uploads, full import/export, custom fields and agent writes remain future work.

## Runtime and release workflow

SvelteKit/Svelte 5, TypeScript, Tailwind and Zod; PostgreSQL 16 and Drizzle; Better
Auth for accounts and OAuth. Node 24 and Docker Compose run on a VPS behind
Cloudflare Tunnel. Accepted photos use private S3-compatible object storage. The
database has no public port. One origin is not a redundant deployment.

Application code and fictional tests are public. Credentials, workout payloads,
production dumps and host settings remain outside this repository. Releases follow
local/CI gates, backup checks, production wrappers, retained recovery images and
public test-account verification. Owner/client acceptance is recorded separately.

Current operations: [STATUS.md](STATUS.md), [release log](docs/release-0.2.0.md),
[public address](docs/public-address.md), [migrations](docs/migrations.md),
[development rules](CLAUDE.md). Earlier single-user/systemd descriptions are
historical and remain available in Git history.
