# Equipment from a photo (0.4.0)

Add a machine to a gym by photographing its placard: the label on the frame
with the maker, the model code and usually the name. A vision model reads the
photo and suggests what the machine is; **you confirm before anything is
added.** The model's output is a suggestion, never a write.

## The flow

1. **Gyms and machines** → under a gym, **Add a machine from a photo**
   (`/gyms/<gym id>/equipment/photo`). One form: the photo and an optional
   note for the reader ("the code is on the seat post"). The file input has
   **no `capture` attribute**, so the phone shows its own sheet: take a
   photo, photo library, or files. With `capture`, Android opens only the
   camera (0.4.0; removed in 0.4.2).
2. **Upload.** The server checks the size and the daily limit, then
   processes the photo (below), stores it privately, and records it as
   `uploaded`.
3. **Analysis**, in the same request: the stored image goes through
   `complete()` with the vision model and a strict schema (below). The result
   is a **candidate**, stored on the photo row with the `llm_calls` row that
   produced it; the photo becomes `analyzed`.
4. **Review** (`/photos/<photo id>/review`): the photo, the candidate field
   by field (manufacturer, model code, name and loading type read with
   confidence under 0.6 are marked "check"), and the **matches** from the
   catalog and your own models. Then one of:
   - **Link** an existing model (a radio list of the matches): a machine is
     added to the gym the photo was taken for. Leave the label blank and it is
     named after the model, e.g. "Hammer Strength Iso-Lateral Row (IL-ROW)"
     (0.3.2's default label). The stack is prefilled when the candidate read one; left blank, it takes the model's standard stack (0.3.2), as on every other way of adding a machine.
   - **Create my own model** from the candidate: every field is prefilled
     and editable; loading type must be chosen when the reader said
     "unknown". The model is yours (`confidence = 'user'`, no source), the
     reader's notes go into the model's notes, and the machine is added as for
     a link.
   - **Discard**: the image is deleted from storage; the photo row stays as a
     record, marked `discarded`, and so does its `llm_calls` row.

   Linking or creating marks the photo `confirmed` and attaches it to the new
   machine. A photo can be confirmed once; a second submit finds nothing to
   confirm and adds nothing.

5. The machine shows the photo as a thumbnail on **Gyms and machines** and on
   the model's page under "In your gyms".

Photos that were never decided are listed on the gym's photo page under
"Waiting for review".

## Privacy

- **All metadata is removed before the photo is stored or analyzed.** The
  upload is auto-oriented, resized to fit 1600 px on its long edge and
  re-encoded as JPEG (quality 85) with sharp, which writes no EXIF, XMP or ICC
  unless asked; the code never asks. GPS position, camera make and model,
  timestamps and the camera's own thumbnail are gone. The original upload is
  never stored. The stored image is the only one ever sent to a model.
- **The bucket is private.** Nothing is served by a public or presigned URL.
- **Images are served only to their owner**, through
  `GET /photos/<id>/image`, which checks that the photo is the signed-in
  user's (another user's photo, a discarded one and a missing id are the same 404) and answers with `Cache-Control: no-store`. It is same-origin, so the
  Content-Security-Policy (`img-src 'self'`) did not change.
- Keys are `users/<user id>/equipment-photos/<photo id>.jpg`: everything a
  user uploads sits under their own prefix.

## Limits

| Variable            | Default    | Meaning                                                                                                                                                      |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PHOTO_MAX_BYTES`   | `10485760` | Largest upload accepted (10 MB), checked before decoding.                                                                                                    |
| `PHOTO_DAILY_LIMIT` | `20`       | Uploads per user per sliding 24 h (every photo row counts, discarded too). Analyses are counted separately against the same number. `0` refuses all.         |
| `BODY_SIZE_LIMIT`   | `12M`      | adapter-node's request body ceiling. Its own default, 512K, refuses every phone photo before the app sees it. Keep it above `PHOTO_MAX_BYTES` plus a little. |

A refusal is a message on the page, not a throttle: "The photo is 11 MB; the
limit is 10 MB.", "You have uploaded 20 photos in the last 24 hours, the daily
limit. Try again later." Accepted formats are JPEG, PNG and WebP. HEIC is
refused with a message to use JPEG (iOS Safari normally converts HEIC to JPEG
for web uploads, so it should not arrive).

Without `BODY_SIZE_LIMIT`, adapter-node 5 refuses an upload over 512K while
building the request, and SvelteKit answers **500** (the log says
`Content-length of N exceeds limit of 524288 bytes`), not 413. If uploads fail
with a 500 after a deploy, check that the variable reached the container.

Analysis also goes through the LLM layer's own per-user hourly cap
(`LLM_MAX_CALLS_PER_USER_PER_HOUR`, `docs/llm.md`).

## Storage

`src/lib/server/photos/store.ts`: one `PhotoStore` interface (`put`, `get`,
`delete`) with two implementations, chosen by `PHOTO_STORE`:

- `s3` (default): `@aws-sdk/client-s3` against `S3_ENDPOINT`, `S3_REGION`,
  `S3_BUCKET`, with `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`. Linode Object
  Storage is S3-compatible and needs nothing else. Checksums are sent only
  where the S3 API requires them (the SDK's newer default adds CRC32 headers
  that several S3-compatible stores refuse).
- `memory`: a `Map` in the process, for tests and the e2e harness. Lost on
  restart; never for production.

The store is built on first use, never at import or boot, so the app runs with
no S3 variable set. A missing one is a `PhotoConfigError` naming the variables
(never their values) for the request that needed it; the page says photo
storage is not set up, and the server log names what is missing.

Every variable has a passthrough line in `docker-compose.yml` and is checked by
`scripts/check-env-passthrough.sh` and `env-passthrough.test.ts`. (Owner
decision 2026-10-01: there is no `secrets-apply.sh` and no allowlist.)

## What the model is asked, and what it is not

The call is `complete(db, userId, { purpose: 'equipment_from_photo', kind:
'vision', system, messages, schema })` (`photos/analyze.ts`), using
`LLM_VISION_MODEL` (falling back to `LLM_MODEL`). The message is the stored
JPEG plus "Read this machine's placard." and your note, if any.

The schema, `EquipmentCandidate`: `placard_text` (verbatim, `''` if none),
`manufacturer`, `product_line`, `model_code` (exactly as printed),
`name`, `loading_type` (`selectorized` | `plate_loaded` | `cable_stack` |
`unknown`), `laterality` (`independent` | `bilateral` | `unknown`),
`starting_resistance_lb` (only if printed), `stack_lb` (only if a stack is
visible and its top plate legible), `field_confidence` (0–1 for manufacturer,
model code, name, loading type) and `notes` (what was unclear).

The system prompt, verbatim in the module, tells it to report only what is
visible; that `null` beats a guess; to transcribe the model code character for
character; never to estimate starting resistance; and, if no placard is
visible, to say so in `notes`.

It is **not** asked to identify a machine from its shape, to look anything up,
to estimate weights, or to choose a catalog row. Matching is done by the app,
and choosing is done by you.

## Matching

`matchCandidate(db, userId, candidate)` (`photos/match.ts`), over the current
global catalog and your own models (`modelVisibleTo`: another user's models,
and catalog rows a later snapshot retired, never match), first hit wins:

1. **Exact**: manufacturer (case-insensitive) and model code, ignoring case,
   whitespace and hyphens (`IL ROW` = `IL-ROW`). Preselected. If both the
   catalog row and your own copy match, both are shown and your copy is
   preselected.
2. **Leading digit** (owner-approved, 2026-10-01): within the manufacturer,
   the two normalized codes differ only by ONE leading digit on one side —
   Nautilus lists `9NP-L3004` where the placard prints `NP-L3004`, or the
   reverse. The shared part must be at least 4 characters. One match is
   preselected and labelled "leading-digit match"; several are listed with
   none preselected.
3. **Prefix** (owner addition, 2026-10-01): catalogs often list a base code
   where the placard prints the full SKU — Technogym `MB20` vs placard
   `MB200N0-ANV0GGGP`, Pure `MG3000` vs `MG3000-NBGJV0`. Within the
   manufacturer, a code whose normalized form is a prefix of the other's, the
   shorter at least 4 characters, matches. One match is preselected and
   labelled "prefix match"; several are listed with none preselected.
4. **Name**: the candidate name's words of 3+ characters, each matched with
   `ILIKE` against model names, ranked by how many match and then by the
   shorter name (so "Iso-Lateral Row" outranks "Iso-Lateral High Row" for
   "Iso Lateral Row"); within the manufacturer when it is one you can see,
   otherwise across all; top 5; nothing preselected.
5. **None**: the page says so, and "Create my own model" is the way on.

**If a photo is preselected to the wrong model, suspect the leading-digit
rule first.** It is the loosest rule that still preselects: a catalog with two
codes one digit apart that are genuinely different machines would put the
wrong one first when the placard's digit is missing or misread. The review page
labels such a match "leading-digit match", so it is visible before linking.

## Re-running analysis

On the review page, **Re-analyze** (with an optional new note) reads the
stored photo again and replaces the candidate. It is allowed while the photo is
`uploaded` or `analyzed`, counts against the daily analysis limit, and records
its own `llm_calls` row. If analysis fails — the model's answer does not fit
the schema, the provider errors or times out, the layer is not configured, or
a limit is reached — the photo stays as it was ("Analysis failed, try again"),
and `llm_calls` records why:

```sql
select created_at, status, error_code, model
from llm_calls where purpose = 'equipment_from_photo'
order by created_at desc limit 10;
```

## Data

`equipment_photos` (migration 0016): `id`, `user_id` (owner, NOT NULL),
`gym_id`, `storage_key` (unique), `content_type`, `bytes`, `width`, `height`
and `sha256` of the stored image, `status` (`uploaded` → `analyzed` →
`confirmed` | `discarded`), `llm_call_id`, `candidate` (jsonb),
`matched_model_id`, `created_model_id`, `gym_equipment_id`, `created_at`.
Every constraint is named; every FK column is indexed.

## Tests

All offline. `photos/store.test.ts` (memory store; S3 commands through a fake
client), `process.test.ts` (a generated 4000×3000 JPEG with EXIF orientation 6
and GPS → ≤1600 px, turned, no EXIF; 12 MB refused; PNG re-encoded),
`upload.db.test.ts`, `analyze.db.test.ts` (the SDK's mock model through a real
`complete()`, via `llm/test-models.ts`), `match.db.test.ts`,
`confirm.db.test.ts`, the review route's `page.server.test.ts`, and
`e2e/photos.e2e.ts` on the served build with the memory store and no LLM key.
Fixture photos are generated in the tests; none is a real photo.

## Not in this release

Bulk capture; a photo-only machine without a model; OCR when no model is
configured; cleanup of `discarded` rows; per-photo cost display.

## Incomplete replies (0.4.1)

`EquipmentCandidate` accepts a reply with keys missing: an absent nullable
field is `null`, absent text is `''`, an absent loading type or laterality is
`'unknown'`, and an absent confidence is `0` (so the review page marks the
field as low confidence). Models without enforced structured output omit keys
they have nothing for; production's first analysis (2026-10-01) read the
placard correctly and was refused as `schema_error` for omitting
`product_line`. Wrong types and out-of-range values are still a
`schema_error`.

## The model's own wording (0.4.3)

`loading_type` and `laterality` map synonyms before validation (`oneOf` in
`analyze.ts`): e.g. `weight_stack`, `stack`, `pin_loaded` -> `selectorized`;
`plate` -> `plate_loaded`; `cable`, `pulley` -> `cable_stack`; `iso-lateral`,
`unilateral`, `dual` -> `independent`. Case, spaces, hyphens and slashes are
ignored. Any other string becomes `unknown`; a non-string is still a
`schema_error`. Found on the owner's first two real placards, both read
correctly and refused for `iso-lateral` and `weight_stack`.

## What the model is sent (0.4.4)

`complete()` takes an optional `wireSchema`: the JSON schema sent to the model,
while `schema` (zod) still validates the reply. Photo analysis sends
`CANDIDATE_WIRE_SCHEMA` (fields, types, enums; no lengths, ranges, defaults or
`anyOf`). Measured 2026-10-01, Claude Haiku 4.5 via OpenRouter, the owner's
prompt and a placard image: the zod-derived schema 15-16 s per call (routed to
Anthropic, and the source of the 60 s timeouts), the plain schema 3.7-7 s,
JSON mode without a schema 3.2-3.4 s. `candidate-wire.test.ts` fails if the
two schemas disagree on fields or enum values, or if a constraint creeps back
into the wire schema.

## The model in production

`LLM_VISION_MODEL=google/gemini-2.5-flash-lite` since 2026-10-01 (0.4.6
deploy): about 2.2-2.7 s per placard and about $0.0002 per call, and it read
the gym80 maker correctly where Claude Haiku 4.5 took the product line for it.
The comparison is in `docs/release-0.2.0.md` §22. Changing model is one env
line and a restart; `complete()` and the wire schema are model-neutral.

## Known gaps (first real use, 2026-10-01)

- **The gym80 logo is misread** ("Dyumbo", "Gymbo") or the product line is
  given as the maker ("Pure Kraft", "FIRE KRAFT"). Codes still matched. A
  manufacturer-alias step before matching is the planned cheap fix.
- **gym80 Pure Kraft is incomplete in the catalog** (4157 Booty Booster read
  correctly, no catalog row).
- **No placard, no reading.** A photo of the whole machine returns nothing
  useful; machine-only recognition is not built (see the handoff for the
  two-stage idea).
