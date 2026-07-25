# Party

Split club tables with people you'd actually want at your table.

## Local development

    docker compose up -d
    cp .env.example .env.local        # then fill in AUTH_SECRET and RESEND_API_KEY
    npm install
    npm run db:migrate
    FOUNDER_EMAIL=you@example.com npm run db:seed
    npm run dev

Generate a secret with `openssl rand -base64 33` and put it in `AUTH_SECRET`.

Postgres listens on host port **5435**, not the usual 5432 — that avoids both a
PostgreSQL already running on the host and any other project's container on
5433 or 5434.

### Signing in without waiting for email

    npm run dev:session -- you@example.com

Prints a session token and the one-liner to set it as a cookie. Reading
`verification_tokens` and building a callback URL does **not** work: Auth.js
stores `hashToken(raw)`, while the emailed link carries the raw token.

## Tests

    npm test                 # domain — pure, fast, no database
    npm run test:integration # repositories and server actions — needs docker compose up

Integration tests need the `party_test` database:

    docker compose exec -T db psql -U party -d party -c "CREATE DATABASE party_test"
    DATABASE_URL=postgres://party:party@localhost:5435/party_test npm run db:migrate

Anything testing real contention must give each racer its own client via
`independentDb()` from `tests/support/db-clients.ts`. postgres.js pipelines one
client's work onto a single connection in FIFO order — transactions included —
so `Promise.all` over a shared client serialises, and a concurrency test will
pass against code that has no locking at all.

## Production

A single DigitalOcean Droplet running `docker-compose.prod.yml`: Postgres, the
Next.js app, and Caddy as a TLS-terminating reverse proxy.

The site is served at **https://wazup.party**. DNS is on Cloudflare with the
records set to **DNS only** (grey cloud) — Caddy holds its own Let's Encrypt
certificate, and Cloudflare's proxy in its default Flexible SSL mode would fight
Caddy's HTTP-to-HTTPS redirect and produce a redirect loop. To enable the proxy,
first set SSL/TLS mode to Full (strict).

Deploy:

    ssh root@<droplet-ip>
    cd /opt/party && git pull && docker compose -f docker-compose.prod.yml up -d --build

Postgres is not published to the host. Reach it with
`docker compose -f docker-compose.prod.yml exec db psql -U party party`.

`migrate` runs to completion before `web` starts, so the schema is never behind
the code. **`drizzle/meta` must not be gitignored or dockerignored** —
`drizzle-kit migrate` reads `drizzle/meta/_journal.json` to discover which
migrations exist, and without it the migrate step applies nothing, succeeds
silently, and the app starts against an empty database.

To run the production stack locally, pass a distinct project name so it does not
recreate the development container:

    docker compose -p party-prod -f docker-compose.prod.yml --env-file .env.production up -d

### Email

`wazup.party` is a verified sending domain in Resend, so magic links and
notifications reach any member. `EMAIL_FROM` is `Party <hello@wazup.party>`.

The DKIM, SPF and return-path MX records must all stay **DNS only** in
Cloudflare; a proxied record silently fails verification. If deliverability
degrades, check Resend's dashboard logs first — a rejected send is reported
there with a reason.

## Architecture

Business logic lives in `lib/domain/**` as plain TypeScript with no framework
imports — a lint rule enforces this. Persistence sits behind repository
interfaces in `lib/domain/**/ports.ts`, implemented in `lib/db/repositories/**`.
Server actions authenticate, call a domain function, and revalidate; they hold
no business logic.

Money is whole rupiah stored as `bigint`. Never floats.

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for
implementation plans.
