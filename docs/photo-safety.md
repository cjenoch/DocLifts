# Alpha image safety (0.15.0)

Every new gym and workout photo goes through the same gate: validate ownership
and limits, rebuild a metadata-free JPEG in RAM, require a safety pass, then
write the object and photo row. A blocked or unavailable result writes no photo,
object or workout block and never reaches equipment identification. Existing
stored photos are not retroactively rescanned by this release.

On a phone, a refusal appears beside the photo control. The workout and saved
sets remain available; the user can add an exercise manually. There is no
rejected-image review gallery, email, or automatic reporting integration.
A classifier label is not a human finding about the photograph.

## Providers and switching

All inference goes through `complete()` and its `photo_safety` purpose.

| `PHOTO_SAFETY_MODE` | Behaviour                                                           |
| ------------------- | ------------------------------------------------------------------- |
| `openrouter`        | Llama Guard 4 12B through OpenRouter, DeepInfra only; no fallback.  |
| `local`             | Pinned Falconsai NSFW classifier in the private CPU service.        |
| `ab`                | Stable 50/50 user assignment from SHA-256; one provider per upload. |
| `paused`            | Refuse all new photos. Manual logging continues. The default.       |

These models have different coverage. The local model scores NSFW/normal
classes; it does not implement Llama Guard's broader category taxonomy. A/B is
an Alpha comparison, not evidence that both arms provide equivalent coverage.
Start with `openrouter`; use local/A-B for the controlled Alpha comparison.
Do not open signup on the strength of synthetic rejection tests alone.

Set the mode in the private production env file, then run
`scripts/compose-prod.sh --profile safety up -d --wait safety web`. The local
service must be healthy before selecting `local` or `ab`. Changing modes
recreates web; it does not modify old photos. Restore the prior mode and recreate
web to undo a switch. There is no production bypass or automatic failover.
`test-pass` requires both Vitest and a database name ending `_test`; production
Compose supplies neither.

Tunables: timeout 5 seconds (100 ms to 15 seconds), local NSFW threshold 0.5
(scores at or above it refuse), and 60 attempts per user per rolling hour.
Reservations are atomic and count errors and blocked verdicts. The existing
stored-photo daily cap and OpenRouter key budget remain in force. Deadlines,
malformed replies, missing keys, a busy service and exceeded caps fail closed.

## Data handling

The upload handler and local service use memory buffers, not temporary upload
files. Rejected buffers owned by the upload function are zeroed; runtime copies
are released normally, not guaranteed securely erased. Web and scanner have
read-only roots, RAM-backed temporary folders, no core dumps and no swap.
The tunnel connector also has no swap and no core dumps. The local service has
no credentials, published port, mounted data or outbound network.

This describes our upload path, not the user's phone, Cloudflare, hypervisor or
remote providers. Remote mode sends the cleaned image to OpenRouter/DeepInfra
before storage. `data_collection: deny` disallows training routes; it is not a
zero-retention guarantee. See [provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging).

Audit rows contain user id, model/provider, policy version, mode, threshold,
decision/categories/score, latency, token counts, reported cost and a truncated
SHA-256 fingerprint. No image, prompt or raw reply is retained by this safety
path, even if normal LLM prompt logging is enabled. Reports belong in the private
data repository and exclude pictures, credentials and tester identities.
`status: ok` means inference completed; `output.allowed` is the decision.

## Testing without harmful material

Generated pixels with injected scanner responses exercise accepts, refusals,
thresholds, malformed replies, errors, timeouts, quotas and account isolation.
Phone-sized served-build tests use the actual gym/workout photo controls, verify
unchanged photo/block/identification counts on refusal, then save another set.
`services/photo-safety/smoke.py`, piped to Python inside the classifier container,
checks real inference on a generated colour image and invalid-input refusals.

Clean equipment photos measure false positives, latency and cost. Do not collect
or retain harmful pictures for this suite. Injected refusals prove enforcement,
not detection accuracy. Broader recall needs provider-published evaluations or
an independently managed evaluation returning aggregate results only. This
classifier is not a known-illegal-image hash-matching service.
