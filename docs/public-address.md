# Public address and tunnel

Production has used https://doclifts.runthe.ai since the October 3, 2026 cutover
(0.14.1). Assistant cutover checks passed; the owner approved those releases that
day. Current application: **0.20.0 Alpha**; see [status](../STATUS.md) for runtime
identity and the separate acceptance checks for later releases.

`PUBLIC_ORIGIN` is the sole browser origin. Compose also passes it as adapter-node's
`ORIGIN`. Change it and restart to move the same build. Adapter-node 5.5.4 builds
the request URL from `origin || get_origin(req.headers)`; forwarded host and
protocol settings have been removed. The deployed MCP release replaced the
framework-global CSRF check with an explicit same-origin form boundary and one
cookie-free native token-exchange exception; see [MCP authorization](mcp-alpha.md).
Cookies are host-only; HTTPS
selects Secure cookies. The served-build tests verify these attributes.

At tunnel cutover set `CLIENT_IP_HEADER=cf-connecting-ip` **and**
`DOCLIFTS_TRUSTED_EDGE=cloudflare`. Only that header is read, with no
X-Forwarded-For fallback, including when missing or malformed. The declaration
is what makes the header trustworthy: the app cannot tell a header a proxy
overwrites from one a client supplied, so the pair is checked and a mismatch
stops the server at boot (validated when `src/lib/server/client-ip.ts` is
imported, which every server boot path does, and enforced again on every call).
`scripts/check-trusted-edge.sh`, run by
`scripts/compose-prod.sh` before any `up`, refuses the deploy first and names
the missing line. Leaving both unset is the development/tailnet-legacy mode:
first-XFF applies and nothing is enforced.
Both the app and Better Auth normalize IPv6 to /64 and IPv4-mapped IPv6 to IPv4.
IPv4 stays whole. The app log hashes the same normalized address.
Trust depends on the app remaining reachable only from the connector and the
owner's private network. Do not publish its port to the internet.

## Readiness

`GET /health` is public (allowlisted, no session) and runs one `select 1`
against the database, bounded by a 2 s `statement_timeout` set inside the
transaction and shared between concurrent probes. It answers `200
{"status":"ok"}` or `503 {"status":"unavailable"}` and nothing else — no host,
no database name, no driver message; the failure is logged server-side once a
minute. The Compose healthcheck targets it, so "unhealthy" now means the app
cannot query its database, not merely that a listener is open. Compose does not
restart a container for being unhealthy: it is a signal for `up --wait`, the
deploy checks and a human.

Two probes are worth keeping distinct: this one, and the login page's own
reachability. A 503 here does not mean sign-in is broken, and a healthy
container does not mean the migration chain has run.

External UptimeRobot checks cover readiness, sign-in and MCP discovery, alongside
the enoch.ai and runthe.ai websites. Cloudflare's tunnel health alert is enabled
for all health transitions, including recovery. Its test-email receipt and an
actual outage/recovery drill remain unverified. Discovery monitoring does not
exercise OAuth or authenticated MCP tools. See [monitoring status](../STATUS.md#external-availability-monitoring)
for the recorded configuration and remaining checks. The local privacy-worker
health monitor remains a separate service-state/cleanup check with no outbound alerts.

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

For rollback: restore the prior PUBLIC_ORIGIN, set
`DOCLIFTS_TRUSTED_EDGE=none` and clear `CLIENT_IP_HEADER` **together**,
stop cloudflared with the wrapper, and recreate web. No rebuild or database
restore is needed for an address rollback. Keep the prior image until acceptance.
The pair moves together in both directions: with `DOCLIFTS_TRUSTED_EDGE=cloudflare`
and no header the app refuses to boot (and the wrapper refuses the start), and
with `DOCLIFTS_TRUSTED_EDGE=none` plus a header it refuses too, because nothing
would overwrite a header the client can set. Confirm the private address works
again and the public address goes down, then repeat the coordinated switch to
public after the rehearsal.

## Connector security updates

Compose pins cloudflared **2026.10.6** by version and manifest digest. Versions
before 2026.10.2 retain trust in the compromised eMudhra intermediates described
in [Cloudflare's advisory](https://blog.cloudflare.com/emudhra-certificate-compromise/).
Inspect every host and the dashboard connector inventory; an offline replica
must also be upgraded before it reconnects.

Before upgrading, inspect the private ingress configuration without exposing
credentials. Replace any HTTPS origin certificate chaining to an affected
intermediate first. Never use `noTLSVerify` to work around certificate rejection.
The production ingress inspected on October 26 uses `http://web:3000` for the
browser and MCP hosts, with an explicit 404 fallback, so it has no HTTPS origin
certificate to replace.

After the required gates, verified backup and Compose dry run:

1. Pull the exact patched image from Compose and verify `cloudflared --version`.
2. Start a temporary replica of the same tunnel using that image, the same
   private read-only configuration mount and Docker network, and the existing
   non-root user, memory limits and security restrictions. Publish no ports.
3. Confirm the new replica has registered its edge connections and passes its
   local `/ready` check. Keep metrics reachable only inside its container.
4. Recreate only the original connector with
   `sudo -n scripts/compose-prod.sh --profile public up -d --no-deps cloudflared`.
   A restart alone keeps the vulnerable image. `--no-deps` avoids recreating web.
5. Check the original connector's version and connection registrations, then
   public `/health`, sign-in and MCP discovery. Confirm the tunnel is Healthy
   in Cloudflare before removing the temporary replica.
6. Stop the temporary replica gracefully and repeat the public probes. Retain
   private rollout evidence; keep credentials and connector configuration out
   of Git.

An overlapping replica keeps new traffic flowing, but long-lived WebSocket,
SSH and other sessions on the retiring connector may need to reconnect. Do not
roll back to a version below the security minimum. The general address rollback
above is separate from a connector security upgrade. See
[Cloudflare's update guidance](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/update-cloudflared/).

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
