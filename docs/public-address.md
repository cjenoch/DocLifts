# Public-address preparation

Production is live at https://doclifts.runthe.ai as of 2026-10-03 (0.14.1).
Assistant cutover checks passed; owner approved both releases on 2026-10-03.

`PUBLIC_ORIGIN` is the sole browser origin. Compose also passes it as adapter-node's
`ORIGIN`. Change it and restart to move the same build. Adapter-node 5.5.4 builds
the request URL from `origin || get_origin(req.headers)`; forwarded host and
protocol settings have been removed. SvelteKit's same-origin CSRF protection
stays enabled, with no trusted-origin exceptions. Cookies are host-only; HTTPS
selects Secure cookies. The served-build tests verify these attributes.

At tunnel cutover set `CLIENT_IP_HEADER=cf-connecting-ip`. Only that header is
read, with no X-Forwarded-For fallback, including when missing or malformed.
Both the app and Better Auth normalize IPv6 to /64 and IPv4-mapped IPv6 to IPv4.
IPv4 stays whole. The app log hashes the same normalized address. An unset/empty
setting preserves the first-XFF behavior for development and the tailnet stage.
Trust depends on the app remaining reachable only from the connector and the
owner's private network. Do not publish its port to the internet.

The IP failure ceiling defaults to ten per fifteen minutes. Email failures
only delay a sign-in, capped at the configured delay (30 seconds by default).
Restore `LOGIN_MAX_FAILURES=10` at public cutover if the tailnet setting is zero.
In-memory counters remain per-process; a second web replica needs shared storage.

The outer response hook adds nosniff and a strict-origin-when-cross-origin
referrer policy to app responses, including auth-handler responses and redirects.
HTTPS origins receive `Strict-Transport-Security: max-age=86400`, without
subdomain or preload directives. CSP already forbids framing. Private responses,
including photo images, carry `private, no-store, must-revalidate` and `Vary: Cookie`.

Adapter-node serves static files before SvelteKit hooks; framework rejections
that happen before hooks also bypass them. The public edge must apply the same
security headers to these responses. Only `/_app/immutable/*` may be cached at
the edge; bypass caching elsewhere, including `/_app/version.json` (which the
adapter already serves with revalidation). Verify these headers through the
actual tunnel before public acceptance. HSTS may rise to six months after a
week of successful use, as a separate configuration change.

The tunnel configuration and credentials remain outside this public repository.
The connector is opt-in through Compose's `public` profile. Set
`DOCLIFTS_TUNNEL_DIR` to the private directory containing `config.yml` and
`credentials.json`, owned/readable by UID 1000. The directory is mounted
read-only; a missing source fails instead of creating an empty directory.
The image is pinned by version and digest, runs without added capabilities,
and publishes no ports. Ingress config remains in the private data repo.

After the reviewed cutover settings and backup are ready:

```sh
sudo -n scripts/compose-prod.sh --profile public up -d --wait web cloudflared
```

For rollback: restore the prior PUBLIC_ORIGIN, clear CLIENT_IP_HEADER,
stop cloudflared with the wrapper, and recreate web. No rebuild or database
restore is needed for an address rollback. Keep the prior image until acceptance.
Confirm the private address works again and the public address goes down, then
repeat the coordinated switch to public after the rehearsal.

## Applied edge policy and operational checks

Security headers, HTTPS redirect, private cache bypass, free managed WAF and
rewrite/analytics disabling are scoped to doclifts.runthe.ai. Access and bot
challenges are off. The Free plan supports the configured ten sign-in requests
per ten seconds with a ten-second block; the app separately counts ten failed
sign-ins per fifteen minutes. Hostname-specific TLS minimum required a paid
feature, so TLS 1.2 was set at zone level; existing site records were DNS-only.
No paid upgrade was made. HSTS stays at one day, without subdomain/preload flags.

Public checks confirmed private routes DYNAMIC (never HIT), immutable CSS HIT,
HTTP-to-HTTPS preserving path/query, and security/noindex headers on static
responses and cross-origin 403 rejections. Two forged X-Forwarded-For values
produced the same real-client hash in failed-login events. Attempts to supply
CF-Connecting-IP were rejected by Cloudflare before reaching the application.
Host listeners were unchanged; web remains tailnet-bound and the connector
publishes no port.

The address rollback restored private sign-in/history and stopped public access
in 8.1 seconds. Public sign-in/history passed after restoration. Compose's
`--dry-run up --wait` incorrectly waited on the deliberately stopped connector;
use `--dry-run up -d` for planning, followed by real `up -d --wait` for health.
The pre-0.14.0 and pre-0.14.1 images were removed after owner approval on
2026-10-03; verified database backups remain retained.
