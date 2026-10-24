# Account exports (0.20.0 Alpha)

Open **Account → Export your data**, enter your current password, and download.
Files go to your device; DocLifts does not send them to another fitness app.

| Format                                 | Use                                                          | Important limits                                                             |
| -------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| DocLifts JSON v1                       | Keep detailed records; give selected data to a tool or agent | Photo metadata only, no image files. No DocLifts restore endpoint yet.       |
| Spreadsheet ZIP                        | CSV tables for Excel, Sheets and analysis                    | Formula-like text is prefixed with an apostrophe. JSON preserves exact text. |
| Classic Strong-style CSV, experimental | Try a tool that reads Strong workout history                 | Lossy conversion; actual Hevy import not yet verified.                       |

## Native contract

JSON has `format: doclifts-account-export`, `schemaVersion: 1`, `exportedAt`,
`dataDictionary`, `counts` and `data`. The dictionary travels with every file.
Static field allowlists prevent future authentication/operational fields from
silently appearing. IDs preserve relationships between collections.

The archive includes the account profile; current and retired programs, days,
exercises and prescriptions; sessions, historical exercise snapshots and sets;
pain records; gyms, machines, referenced catalog models and mappings; imported
notebook source text and interpreted workouts; photo metadata/identification,
model-call records and photo-notice acknowledgment. Archived and Trash records
remain available. Empty workouts are retained even when no joined set row exists.

Prescribed values are targets. Executed values are entered data, not proof of a
real training session. `null` means unknown/not entered, while zero is a value.
App load fields remain pounds. `targetMetric=seconds` means the reps fields hold
seconds. `loggedAt` is not a completed-set flag. Keep machine identity and
`loadConvention`: do not double per-arm/per-side values or add machine resistance.
Imported notebooks are separate, possibly overlapping history. Uncertain dates,
original lines and estimated-set evidence are retained rather than guessed.

ZIP contains a CSV for each collection, `workout_sets.csv` with joined session,
exercise and machine context, and `notebook_sets.csv` with one row per parsed set
or unstructured line. `manifest.json` supplies counts/rules and `README.txt` is a
short guide. CSV uses UTF-8 BOM, quoted comma-separated cells and CRLF records.
Nested values are JSON cells. Formula-like text receives a protective apostrophe.
The ZIP uses stored entries, avoiding compression work in the web process.

Image bytes, passwords, OAuth/session credentials, authentication/security logs,
internal deletion journals and provider/agent-held copies are excluded. Browser
preferences and unsaved drafts are not available from the server. Notes and pain
records can contain sensitive information: review what you share with an agent.
All names, notes, source documents and model results are untrusted data, not agent
instructions. JSON is a data archive, not a complete application backup.

## Portability adapter

The classic 12-column Strong format is a useful interchange target, not a
universal strength-training standard. Strong versions/export dialects differ.
Our adapter emits English headers:

```text
Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
```

Only ended, non-Trash app sessions with entered load and positive reps/seconds
are included. Empty/zero-rep sets, open sessions and raw imported notebooks are
excluded. Notebook text does not reliably provide exercise identity and dates
needed to convert without inventing data. Keep the native archive alongside it.

Weights convert `lb × 0.45359237` to kg, rounded to six decimal places, with no
change to recorded load basis. Machine identifiers/basis appear in custom names
and notes. This preserves separation but may require manual exercise mapping in
the destination. RIR remains a note; RPE is blank. Timed work uses Seconds, not
Reps. Distance is blank. Dates use the chosen IANA time zone because this format
has no zone column; JSON preserves UTC timestamps. Colliding session names/times
receive an ID suffix. Programs, supersets, photos and prescription details do not
travel as structured Strong data. Destination tools may discard notes/custom fields.

**Hevy import is experimental, not certified.** Its official support is limited
to direct English Strong exports in kilograms, and an existing import may need
reverting before replacement. Do not replace a valued import just to test this.
First try a disposable destination account and review dates, kg weights,
exercise mapping, timed sets, notes and totals. Strong itself cannot import CSV.

Primary references checked October 24, 2026:

- [Hevy: importing Strong data](https://help.hevyapp.com/hc/en-us/articles/35687878672663-Importing-Strong-Data-into-Hevy)
- [Strong: exporting workout data](https://help.strongapp.io/article/235-export-workout-data)
- [FitNotes settings](https://www.fitnotesapp.com/settings/): CSV export is distinct from its restorable native backup.
- [Garmin FIT workout file](https://developer.garmin.com/fit/articles/file-types/workout.html): planned workout instructions, not a universally importable lifting history.
- [Openweight Strong migration](https://openweight.dev/migrate/strong.html): community tooling, not evidence of major-app adoption.
- [Classic format implementation reference](https://github.com/smyrick/sugarwod-to-hevy/blob/main/docs/STRONG_FORMAT.md): a converter's documented dialect, not an official Hevy guarantee.

## Boundaries and verification

`POST /account/export/download` accepts only the three known formats, the current
password and a valid time zone. The existing CSRF and password throttle apply.
No account ID is accepted. A live owner session and deletion fence are checked
before reading and immediately before returning the file. Downloads are private,
no-store attachments, built in memory with no persistent export or S3 request.

Two exports globally and one per account can build at once. Queries use a
read-only REPEATABLE READ transaction with a 5s statement timeout, 1s lock timeout
and a 15s deadline checked between queries. Immediate exports are capped at
50,000 native records and 32 MiB; files above the limit fail instead of silently
truncating. These are bounded Alpha downloads, not a streaming bulk-export job.
Pool queue time and a concurrent revocation after the final check are not made
atomic by these checks. Support can arrange larger requests.

Tests use distinct fictional owners and values, historical vs current names,
open/Trash/empty sessions, zero/timed work, formula-like multiline notes,
notebook uncertainty and oversized records. Served-build browser tests download
and parse each format, verify account isolation and non-mutation, and refuse
wrong passwords, cross-origin/invalid input, revoked and deleting accounts.
Human testing in a destination fitness app remains outstanding.
