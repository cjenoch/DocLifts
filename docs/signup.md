# Alpha pilot sign-up (0.15.0, not deployed)

How this is used on a phone: open Create an account, enter the shared invite
code, name, email and password, accept the test-system notice, then follow the
verification email and sign in. A matching code and verified email automatically
approve the account; there is no manual approval queue.

## Gates and defaults

- SIGNUP_ENABLED=0 keeps browser registration closed; existing sign-in works.
- When enabled, SIGNUP_INVITE_CODE must contain at least 16 characters and mail
  must be configured. Keep the code outside Git; rotate it to stop further use.
- SIGNUP_MAX_ACCOUNTS defaults to 25 pilot accounts, including unverified ones.
  Operator-created accounts are excluded. Admissions and user/credential creation
  are committed atomically under a database advisory lock. Pending accounts do
  not expire automatically; the owner can raise the cap or handle abandoned
  accounts deliberately. Disabling sign-up stops new admissions, not existing
  account verification or sign-in.
- Five valid-form attempts per IP/hour, three per email/hour and thirty site-wide
  per hour. Bad invite codes count. Missing trusted IP refuses admission. IPv6
  /64 normalization and trusted header selection reuse the sign-in implementation.
- Sign-up attempt counters live in the auth schema, contain keyed hashes rather
  than raw addresses, and are pruned after one day on the next attempt. These are
  anonymous authentication control records, not shared workout data. Pilot
  admissions and mail records are user-owned and cascade on account deletion.
- Native /api/auth/sign-up/email remains disabled, even if the obsolete
  DOCLIFTS_OPEN_SIGNUP variable is set. There is no alternate ungated API path.
- Existing operator-created accounts are verified already. Verification is
  mandatory at sign-in, so pending pilot users cannot enter through the API.

## Verification mail

MAIL_PROVIDER is off, log (bounded in-memory development outbox) or resend.
MAIL_API_KEY is sending-only, domain-restricted, outside Git. MAIL_FROM defaults
to DocLifts <no-reply@mail.runthe.ai>; MAIL_REPLY_TO to support@runthe.ai.
MAIL_DAILY_LIMIT defaults to 100, counting attempts, including failed sends.
A per-account limit of three verification sends/hour applies across the native
resend endpoint and the UI. Database reservations prevent concurrent overspend
and survive restarts. Provider calls time out after ten seconds.

Mail is dispatched in the server background. Failure never reveals account
existence. Delivery status/provider ID are recorded, never a token, body, URL or
raw provider error. A process crash can leave a pending record without delivery;
the user can request another email, subject to the same allowance. There is no
persisted plaintext mail queue or automatic retry loop.

Better Auth 1.7.6 issues a signed JWT verification link, valid for 30 minutes.
It is not stored in the database. Verification is idempotent; resending does not
invalidate an earlier unexpired link. It only verifies the address and never
creates a session or changes a password. These are email-verification links,
not the password-reset/invite links described in SPEC-email. Reset, password
change notices and individual emailed invites remain separate work.

The token-bearing /api/auth/verify-email response gets no-referrer and no-store.
Its token-free /verify landing page uses the normal referrer policy: applying
no-referrer there caused the next browser form POST to lose a usable Origin.
The real-browser test covers this complete navigation, verification and sign-in.

## Deployment checklist

Auth changes require owner review before main, then the normal full gate, CI,
verified backup and previous-image retention. Migration 0020 is additive.
Before enabling: install the domain-limited sending key and mail settings,
generate/store an invite code, choose the pilot cap, verify a real email loop,
and restore the quiet-deploy check as soon as the first outside user is created.

Cloudflare currently overwrites Referrer-Policy on all app responses. Before
this release is enabled, add a final hostname/path-scoped transform setting
no-referrer for /api/auth/verify-email only; leave the token-free landing page
on the normal policy. Extend the existing auth edge rate rule to /signup,
/verify, and /api/auth/send-verification-email (POST only). No bot challenge is
needed for the invite-only pilot; opening admission without a code is a separate
policy change that should add stronger automation controls.

No OpenRouter funding or key-limit change is part of this release. Existing
per-user call limits and the provider key budget remain active. Workout logging
continues if AI is exhausted. The owner will fund OpenRouter directly; no key budget change is authorized.
