# Password entry and MCP admission

The SvelteKit auth singleton wraps Better Auth's HTTP handler with
`passwordEntryHandler`. Both the public `/api/auth/sign-in/email` JSON endpoint
and `/login`'s server-side proxy call that same boundary. JSON and URL-encoded forms use Fetch decoding, including the last duplicate-key value; malformed and unsupported bodies are rejected before verification. There is no privileged
request header or public bypass. Cookies, origin checks and Better Auth's volume
backstop still pass through its handler. Only a 401 credential refusal records a
failure; successful sign-ins clear their counters. The form keeps its delay notice
through process-local response metadata, never through client-supplied headers.

The existing failure policy is unchanged: IP failures may refuse a request; email
failures may only delay it. One password attempt per normalized IP may be active
at once, spanning body reading, delay and verification. Concurrent attempts from
the same IP receive 429 with a one-second retry hint, without a queue. This also
affects people sharing a NAT: simultaneous legitimate sign-ins must retry after
the first completes. Sequential correct-password sign-ins do not accumulate
failures. At most 32 password requests are active per process; additional clients
receive temporary 503 backpressure. Bodies are limited to 32 KiB and ten seconds.

Failure tracking has separate limits of 4,096 IP keys and 4,096 email keys per
process. Keys are full SHA-256 digests, so accepted email lengths do not increase
retained key size. Each key keeps only the newest timestamps needed for the
configured IP ceiling and capped delay curve (36 timestamps at defaults).
Every check, failure and success sweeps up to 64 entries in each store, rotating
live entries so unrelated expired keys are eventually collected. No background
timer is needed; idle retained state stays within those bounds.

A full IP store never evicts an unexpired penalty: an untracked IP receives
temporary 503 with a one-second Retry-After, while tracked IPs retain their usual
admission policy. Expiry and successful sign-in free slots. A sweep may require
several requests to reach expired entries, but continuing traffic cannot leave
them permanently unreachable. Email capacity alone never refuses a sign-in;
new email delay counters are omitted while that store is full. Concurrent
credential checks admitted before saturation may finish without a new counter,
but cannot grow either store or displace existing failures. Thus saturation is
an explicit availability tradeoff, not a bypass that resets a tracked IP or an
email-wide hard lock. The per-key timestamp bound follows operator configuration;
larger configured ceilings or delay thresholds increase that memory allowance.

The installed Better Auth router rejects repeated slashes and uses exact route
matching. The boundary additionally recognizes decoded and trailing-slash forms
of the password endpoint, so these cannot select an unthrottled handler path.
OAuth, logout and session-authenticated password change retain their existing
handler paths.

MCP keeps its eight-request global bound before authentication. Each normalized
IP may run two token lookups concurrently; that lane is released immediately
after authentication so normal parallel tool reads can proceed. Repeated denied
tokens are rejected without another database lookup for five seconds. The cache
contains at most 1,000 token hashes with FIFO eviction, never raw bearer tokens.
Successful tokens are never cached: session and consent revocation are checked
on every request and again at tool execution. A cache denial retains the 401
Bearer challenge; lookup backpressure returns 429 with Retry-After.

These controls are in memory and local to one process. A restart clears them;
another replica has independent counters. `DOCLIFTS_RATE_LIMIT_STORAGE=database`
only changes Better Auth's own backstop, not these maps. Trusted proxy IP header
configuration is required to make IP identity meaningful. Missing or malformed
IP values share a bounded fallback lane.

Those controls also require the header to be configured at all, so a deployment
can no longer be started in the legacy `X-Forwarded-For` mode by accident: the
production wrapper refuses a start that has not declared
`DOCLIFTS_TRUSTED_EDGE` (`cloudflare` with `CLIENT_IP_HEADER=cf-connecting-ip`,
or `none` with no header), and the app refuses to boot on a mismatched pair. See
[public address](public-address.md).

This does not prevent distributed credential guessing or guarantee availability
under a distributed attack. Email-only delays deliberately do not serialize or
lock an account, so different IPs can attempt the same email concurrently. That
preserves the owner's ability to sign in from another address. Distributed slow
requests can occupy the global password bound, and distinct bogus MCP tokens
from multiple addresses can still occupy the global MCP/authentication capacity.
Those residual risks require edge controls or shared admission state before
scaling; neither is claimed to be solved here.
