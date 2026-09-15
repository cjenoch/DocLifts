# Try DocLifts with fictional workouts

Install Docker with Docker Compose. From the repository root:

```sh
docker compose -f compose.demo.yml up --build -d
```

Wait for initialization to complete, then open **http://localhost:4179**. No `.env` file, external database, account, or Tailscale setup is needed. The first build downloads dependencies and may take several minutes.

The sample program includes three training days, nine exercises, a named demo gym, completed workouts for history/reports, one active workout, and a workout in Trash. All records are fictional. The banner identifies demo mode. Try Resume, save a set, add an exercise, create a program, or restore the Trash example.

Check readiness or troubleshoot:

```sh
docker compose -f compose.demo.yml ps -a
docker compose -f compose.demo.yml logs init web
```

## Reset or stop

The database uses temporary memory storage; changes are disposable. To reliably start over, recreate the whole demo:

```sh
docker compose -f compose.demo.yml down
docker compose -f compose.demo.yml up -d
```

Use `docker compose -f compose.demo.yml down` to stop it. Do not use this demo stack for training records you want to keep. Stopping/recreating the database can discard the data; after that, recreate the whole stack so initialization runs again. Browser-tab drafts can be cleared by closing the demo tab.

## Isolation and guardrails

- Only localhost port 4179 is published. PostgreSQL has no host port.
- The demo has its own Compose project and no production-volume mounts. It does not read `.env`.
- The local demo password is deliberately public and works only within this demo network.
- The seed requires `DOCLIFTS_DEMO=1` and the database name `doclifts_demo`. It refuses populated databases and never truncates or replaces existing data. Re-running a completed seed is a no-op.
- There is no application authentication. Keep personal installations private; do not expose this demo directly to the public internet.
- For persistent installations, use a private PostgreSQL database, run migrations, and create your program through the UI. Do not seed real installations with demo data.

The legacy VPS deployment described in the main README is a separate deployment. Demo commands do not update it.
