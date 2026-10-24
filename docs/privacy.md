# Privacy controls during the Alpha

The public notice is `/privacy`, reachable without signing in and linked from
sign-in and Account. Operator contact: support@runthe.ai. This describes current
behavior; it is not a claim of legal certification or a complete public-launch gate.

## First photo

On a phone, tap Photo next machine to open a scrollable notice in the workout
controls, or open the gym photo page. Read the notice, check the acknowledgment
and continue. No photo picker is rendered before acknowledgment. Logging by hand
remains available. The page does not automatically accept an existing account.

`photo_notice_acknowledgements` stores one row per account: current notice version
and UTC acknowledgment time. It cascades with the account. Repeated acknowledgment
of the same version is idempotent; a new version replaces the old acknowledgment.
This is a current-version gate, not an immutable legal consent audit trail.

Both upload actions check before parsing the photo form. `uploadPhoto` also checks
before image processing, screening or storage, protecting other callers. Only the
signed-in account ID is used by the acknowledgment action. Old or missing versions
and unchecked forms are refused. Session authentication and same-origin POST
protection apply as they do to the existing actions. Enhanced forms keep the page
on a connection failure; plain forms redirect back to the same route.

For a material photo-processing change, update the public notice, first-photo copy
and `PHOTO_NOTICE_VERSION` together. Existing users will then need to acknowledge
again before new uploads. Existing stored-photo reads/reanalysis are not gated by
this new-upload acknowledgment.

## Account and saved-photo removal

Available in 0.19.0 Alpha, runtime `72b3d538`. In Account,
use the current password and explicit destructive confirmation to request account
removal. The server selects the signed-in owner, fences further access and revokes
sessions/agent grants before bounded cleanup. A deletion receipt distinguishes
pending work from completion.

Remove an individual saved photo from its review controls. That removes the image
and its links while preserving recorded workout performance. Account deletion
intentionally removes the account's owned history too; neither control removes
another account's records or the global equipment catalog.

Both paths require verified encrypted off-host journal acknowledgment before
reporting acceptance or erasing objects. A connection/provider failure can leave
an already-fenced account or hidden image awaiting retry; it is not proof that
nothing changed. The operator's bounded worker retries cleanup. Recovery must
reconcile the independently recovered newest journal before reopening a restored
database. See [deletion and retention controls](data-lifecycle.md).

## Boundaries and remaining work

- Photos are private to other users, but accessible to the operator and relevant
  hosting/processing services. Removing EXIF does not remove visible people or signs.
- Production currently compares local screening with remote screening through
  OpenRouter. Identification also goes through OpenRouter. Its providers' retention
  and training policies are not guaranteed by this release. Prompt-text logging is
  disabled, but structured results and operational records persist.
- Notes may contain health information and can reach authorized agents with notes
  scope. Revocation stops future connection access; it cannot recall copied data.
- Password-confirmed JSON and CSV-table exports include account/training records, notes and pain records. Photo metadata is included, but image files are not. Experimental Strong-style CSV exports completed app sets with documented losses. See [data exports](data-exports.md). Support handles additional requests after
  verifying account ownership. Do not ask a user to email passwords or unnecessary
  sensitive information.
- Retention controls remain manual dry-run/apply; no retention timer is enabled.
  Saved photos and valuable history have no silent age purge. Operational-log
  policy remains separate. Encrypted backups expire separately from live data;
  journal reconciliation prevents intentional deletions from silently returning
  after restore. The journal is encrypted but not immutable/WORM storage.
- Local health monitoring records aggregate failures/pending age in a private
  status file and local service logs. It sends no email/webhook and does not detect
  host loss from outside the VPS.
- Signup remains closed. Recheck the notice against deployed settings whenever
  providers, retention, email features or data-sharing behavior change.

Tests cover direct upload enforcement before processing/provider/storage, account
and version boundaries, idempotence, public access, both upload actions, malformed
acknowledgments, connection failure, cross-device persistence and plain HTML forms.
Existing upload fixtures deliberately start with acknowledgment; privacy first-use
fixtures explicitly do not. A bypass canary removes core enforcement and must fail.
