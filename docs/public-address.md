# Public-address preparation

Production remains on its current address until the owner reviews the auth,
origin, CSRF and tunnel diffs and the cutover checks pass.

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
