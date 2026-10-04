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

## Boundaries and remaining work

- Photos are private to other users, but accessible to the operator and relevant
  hosting/processing services. Removing EXIF does not remove visible people or signs.
- Production currently compares local screening with remote screening through
  OpenRouter. Identification also goes through OpenRouter. Its providers' retention
  and training policies are not guaranteed by this release. Prompt-text logging is
  disabled, but structured results and operational records persist.
- Notes may contain health information and can reach authorized agents with notes
  scope. Revocation stops future connection access; it cannot recall copied data.
- Self-service account deletion, complete export and confirmed-photo deletion are
  still outstanding. Support handles requests after verifying account ownership.
  Do not ask a user to email passwords or unnecessary sensitive information.
- Automatic age-based log/discarded-record cleanup is outstanding. Encrypted backup
  retention is separate from live data. Record deletion requests privately and
  reconcile them before any restored copy is returned to service.
- Signup remains closed. Recheck the notice against deployed settings whenever
  providers, retention, email features or data-sharing behavior change.

Tests cover direct upload enforcement before processing/provider/storage, account
and version boundaries, idempotence, public access, both upload actions, malformed
acknowledgments, connection failure, cross-device persistence and plain HTML forms.
Existing upload fixtures deliberately start with acknowledgment; privacy first-use
fixtures explicitly do not. A bypass canary removes core enforcement and must fail.
