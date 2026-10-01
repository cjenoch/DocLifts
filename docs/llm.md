# LLM adapter (0.3.1)

One function every feature calls to get a typed object from a model:
`complete()` in `src/lib/server/llm/index.ts`. It picks the provider from
config, enforces a per-user hourly cap and a timeout, validates the answer
against a zod schema, and records every call in `llm_calls`. **Nothing else in
the app calls a provider SDK** (CLAUDE.md; `llm-seam.test.ts` fails the build
if anything outside `src/lib/server/llm/` imports `ai`, `ai/*`, `@ai-sdk/*` or
`@openrouter/*`).

0.3.1 had no consumer. The first is 0.4.0's equipment photo analysis
(`purpose: 'equipment_from_photo'`, `kind: 'vision'`; `docs/photos.md`). Tests
outside this directory get an offline model from `llm/test-models.ts`, since
`llm-seam.test.ts` forbids `ai/test` imports anywhere else.

**The API key never appears in logs, commits, docs, chat or a command line.**
It lives only in production's env file. The module logs it as `set`/`unset`,
never stores it, and never puts it (or the provider's raw error text) in an
error message.

## The contract

```ts
import { complete, LlmSchemaError } from '$lib/server/llm';

const { output, callId } = await complete(db, userId, {
	purpose: 'equipment_from_photo', // recorded in llm_calls.purpose
	system: 'You read gym machine placards…',
	messages: [
		{
			role: 'user',
			content: [
				{ type: 'text', text: 'What machine is this?' },
				{ type: 'image', image: bytes, mediaType: 'image/jpeg' }
			]
		}
	],
	schema: z.object({ manufacturer: z.string(), code: z.string() }),
	kind: 'vision' // optional; 'text' by default
});
```

- D5 signature: `complete(db, userId, request)`. Every call is on behalf of a
  user; there are no system calls.
- `output` is typed by the schema and has already been validated against it.
- `callId` is the `llm_calls` row for this call.
- User messages take text and image parts; assistant messages take text only
  (the SDK's assistant message type has no image part).
- One provider attempt per call: the SDK's automatic retries are off, so one
  row is one request and the timeout bounds the whole call. To retry, call
  again; the retry is capped and recorded like any call.

### Errors

Every error extends `LlmError` and carries `callId`. **The row is written
before the error is thrown, on every path.** If the row itself cannot be
written, that database error propagates instead.

| Error              | When                                               | Row status / error_code            |
| ------------------ | -------------------------------------------------- | ---------------------------------- |
| `LlmNotConfigured` | key or model missing, unknown provider, bad value  | `refused` / `not_configured`       |
| `LlmRefused`       | the user's hourly cap is used up                   | `refused` / `hourly_cap`           |
| `LlmSchemaError`   | the answer is not JSON, or does not fit the schema | `schema_error` / `no_object`       |
|                    | the model stopped without an object (e.g. length)  | `schema_error` / `no_output`       |
| `LlmProviderError` | HTTP or network failure                            | `provider_error` / `http_<status>` |
|                    | anything else the SDK throws                       | `provider_error` / the error name  |
| `LlmTimeout`       | `LLM_TIMEOUT_MS` passed                            | `timeout` / `timeout`              |

Order inside `complete()`: resolve config → refuse if unusable → cap → one
provider call. Neither refusal reaches the provider.

## The table: `llm_calls` (migration 0013)

| column                               | notes                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `id`                                 | uuid pk                                                                          |
| `user_id`                            | text not null → `auth.user(id)`, NO ACTION (`llm_calls_user_id_fk`)              |
| `purpose`                            | e.g. `ping`, `equipment_from_photo`                                              |
| `provider`                           | `openrouter` today                                                               |
| `model`                              | the model id sent; empty when the call was refused as not configured             |
| `request_id`                         | the provider's response id; null when it sent none                               |
| `status`                             | `ok`, `schema_error`, `provider_error`, `timeout`, `refused` (CHECKed)           |
| `error_code`                         | see the table above; never an error message                                      |
| `prompt_tokens`, `completion_tokens` | from the SDK's `usage.inputTokens` / `outputTokens`; null when unknown           |
| `latency_ms`                         | from the start of `complete()` to the row                                        |
| `prompt_hash`                        | first 16 hex of sha256 over the canonical instructions + messages                |
| `prompt_text`                        | only with `LLM_STORE_PROMPTS=1`; images appear as `sha256:…`, never bytes        |
| `output`                             | the parsed object on `ok`; the raw model text (a jsonb string) on `schema_error` |
| `created_at`                         | timestamptz, default now()                                                       |

Indexes: `llm_calls_user_created_idx (user_id, created_at)`,
`llm_calls_purpose_created_idx (purpose, created_at)`.

**Reading `output` through drizzle:** drizzle's jsonb reader `JSON.parse`s any
string it gets back, so a `schema_error` row whose raw text happens to be valid
JSON reads as an object, although Postgres holds a string. Use SQL
(`jsonb_typeof(output)`, `output #>> '{}'`) when the distinction matters.

`usageForUser(db, userId, since)` returns `{ calls, refused, promptTokens,
completionTokens }` for one user from this table; it is the input for future
quota work.

## Configuration

Read from `process.env` on the **first** `complete()` call — never at import,
never at boot, never through `$env`. The app boots, serves, and passes its whole
gate with none of these set (CI has none). The effective config is logged once,
at first use, as an `llm_config` line with the key shown as `set`/`unset`.

| Variable                          | Default      | Meaning                                                  |
| --------------------------------- | ------------ | -------------------------------------------------------- |
| `LLM_PROVIDER`                    | `openrouter` | the provider; only `openrouter` exists                   |
| `LLM_MODEL`                       | **none**     | model id for text calls; required when used              |
| `LLM_VISION_MODEL`                | `LLM_MODEL`  | model id for `kind: 'vision'`                            |
| `OPENROUTER_API_KEY`              | **none**     | the key; required when used; a secret                    |
| `LLM_TIMEOUT_MS`                  | `30000`      | whole number ≥ 1                                         |
| `LLM_MAX_CALLS_PER_USER_PER_HOUR` | `60`         | whole number ≥ 0; **0 refuses every call** (kill switch) |
| `LLM_STORE_PROMPTS`               | `0`          | `1` stores prompt text                                   |

There is no default model on purpose: a hard-coded id becomes a plausible wrong
value the day it is retired or repriced. A malformed value is never replaced by
the default; it makes the layer not configured, and every problem is listed in
`LlmNotConfigured.problems` (names only, never values).

Every variable has a passthrough line in `docker-compose.yml` (empty = unset),
and `env-passthrough.test.ts` checks each line exists and its default matches
the code. Changing a value in production: edit `/srv/doclifts/.env`, restart
the web container.

## The cap

In-memory, per process, a sliding hour per user — the login throttle's shape
(`llm/cap.ts`). Only calls that are sent to the provider count; refusals do not,
so a loop that keeps asking cannot keep itself locked out. A restart clears it,
and a second replica would multiply it; before a second replica, count from
`llm_calls` instead (the rows are already there).

## Smoke test: `pnpm llm:ping`

One real call, `purpose: 'ping'`, schema `{ ok: boolean, model: string }`,
prompt "Reply with ok true and the model name you are." It prints the parsed
object, the row id, the model sent, tokens and latency — never the key. It
needs an account to call on behalf of:

```sh
pnpm llm:ping --email <account email>
```

It costs a real provider call, so nothing runs it automatically. In production
it runs once, by the owner, in the builder image (the runtime image has no
`tsx`), with the database URL built from the env file the way
`scripts/user-prod.sh` builds it:

```bash
cd /home/chris/code/DocLifts   # the production checkout, at the deployed release
sudo -n bash -c '
  set -euo pipefail
  set -a; source <(grep -E "^[A-Za-z_][A-Za-z0-9_]*=" /srv/doclifts/.env); set +a
  export DATABASE_URL="postgresql://doclifts:${POSTGRES_PASSWORD}@db:5432/doclifts"
  docker build --target builder -t doclifts-migrations:local .
  docker run --rm --network doclifts_default -e DATABASE_URL \
    --env-file /srv/doclifts/.env \
    doclifts-migrations:local pnpm llm:ping --email <your account email>'
```

Expected: `"ok": true`, a non-empty `"model"`, token counts, and a row:

```bash
sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -c \
  "select status, model, prompt_tokens, completion_tokens, latency_ms, prompt_text is null as no_prompt
   from llm_calls where purpose = 'ping' order by created_at desc limit 1"
```

A `refused`/`not_configured` row means a variable is missing from the env file
(the printed error names it). A `provider_error` with `http_401` means the key
is wrong.

## Adding a provider

A `case` in `llm/provider.ts`'s switch, its value in `LLM_PROVIDERS`
(`config.ts`), its key variable in `LLM_ENV` with a compose line, and the
dependency. Nothing outside `src/lib/server/llm/` changes.

## Tests

`src/lib/server/llm/llm.db.test.ts`, server project, entirely offline: every
model is the SDK's `MockLanguageModelV4` from `ai/test`, injected through
`createLlmClient({ model })`. `llm-schema.db.test.ts` checks the table's
constraints and indexes by name; `llm-seam.test.ts` holds the one-seam rule.

SDK names, read from the installed `ai@7.0.123`: structured output is
`generateText({ output: Output.object({ schema }) })` (`generateObject` is
deprecated in 7.x); the system prompt is `instructions`; usage is
`usage.inputTokens` / `usage.outputTokens`; schema misses reject with
`NoObjectGeneratedError`. The provider is `createOpenRouter({ apiKey })` from
`@openrouter/ai-sdk-provider@3.1.0`. Re-read the installed types before
upgrading either; these names have changed across majors.

## `wireSchema` (0.4.4)

`CompleteRequest.wireSchema` is optional. When set, it is the JSON schema the
provider receives (via the SDK's `jsonSchema(..., { validate })`), and the
reply is validated with `schema.safeParse`, so defaults, synonyms and refusals
are exactly those of the zod schema. Use it when the derived schema is heavy:
strict structured output compiles every constraint, and on Anthropic that was
the difference between ~4 s and ~16 s per call.
