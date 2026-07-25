# Party Table Splitting — Design

**Date:** 2026-07-25
**Status:** Approved, ready for implementation planning

## Problem

A table at a club like Savaya or Miss Fish carries a minimum spend that is expensive for
one person and reasonable when split. Today the split happens ad hoc in group chats: one
person commits to the table, then scrambles across WhatsApp threads to find people, and
tracks who paid in their head.

This product does for club tables what padel apps do for courts. A host who has already
booked a table lists the open spots. Members of a curated community see it, request a seat,
and the host approves who joins. Everyone knows the price before committing, and the host
can see at a glance who has paid.

## Scope

### In scope for v1

- Invite-code-gated membership
- Hosts listing already-booked tables at a fixed price per seat
- Members requesting seats; hosts approving or declining each request
- Payment tracking without custody: host attaches their own payment link or QR
- Email notifications for every state change

### Explicitly out of scope for v1

Chat and DMs, ratings and reviews, table photos, recurring tables, waitlists, WhatsApp
integration, refund handling, dynamic pricing, native mobile apps, multi-currency.

Each is a real feature. None is needed to learn whether people will fill each other's
tables, which is the only question v1 exists to answer.

## Product decisions

These were settled during design. They constrain everything downstream.

| Decision | Choice | Consequence |
|---|---|---|
| Audience | Curated community, invite codes from existing members | No public trust infrastructure, no moderation queue, no reporting flows |
| Money | No custody. Host supplies a payment link or QR; the app tracks confirmations | No payment processor, no money-transmitter exposure, no refund engine |
| Commit model | Host books the table with the venue first, then lists open seats | One simple lifecycle. No rally threshold, no deadline, no dissolution path |
| Split math | Host sets a fixed price per seat | Joiners know their cost at request time. No lock deadline, no post-event true-up |
| Join flow | Host approves each request | Hosts control who is at their table. Requires a pending state |
| Notifications | Email | No Meta business account, no template approval, no per-message cost |
| Currency | IDR only, integer minor units | No FX, no rounding drift. Revisit if a Singapore or Bangkok venue appears |

### Membership rules

Every active member holds **three** invite codes. Codes are single-use and expire 30 days
after creation. Spent codes are not automatically replenished in v1 — growth rate is a
thing to watch deliberately, not a thing to automate before there is any data on it.

There is **no admin UI in v1**. Suspending a member, replenishing codes, and merging
duplicate venues are direct database operations. Building an admin console before the
community exists would be building for an imagined workload.

The founding member is seeded by migration, since invite codes require an inviter.

## Architecture

**Stack:** Next.js 15 (App Router, TypeScript) · PostgreSQL · Drizzle ORM with drizzle-kit
migrations · Auth.js v5 magic links · Resend for email · Tailwind with shadcn/ui ·
DigitalOcean App Platform (web component plus managed Postgres).

Next.js is the whole backend. There is no separate API service.

### The one structural rule

All business logic lives in `lib/domain/*` as plain TypeScript: pure functions and
repository interfaces, with no `next/*` imports and no React. Server actions and route
handlers are thin adapters that authenticate the caller, invoke a domain function, and
revalidate.

This buys two things. Domain tests need no browser and no running server, so they are fast
enough to run on save. And extracting the domain into a standalone service later — when a
native mobile app justifies it — becomes a mechanical move rather than a rewrite.

### Modules

| Module | Owns | Depends on |
|---|---|---|
| `membership` | Invite codes, accounts, profiles | — |
| `tables` | Table listings and their lifecycle | `membership` |
| `seats` | Join requests, approvals, roster | `tables`, `membership` |
| `settlement` | Host payment link, per-seat payment status | `seats` |
| `notify` | Email templates and dispatch | Called by the others; imports none of them |

Dependencies point one direction only. `notify` receives payloads and knows nothing about
the modules that call it.

### Mobile-first

Every real use happens on a phone, much of it late at night in a loud room. Desktop is a
widened phone layout, not a separate design.

## Data model

Money is stored as `integer` minor units throughout. No floating-point money, anywhere.

```
users            id, email, name, instagram_handle, avatar_url,
                 status(active|suspended), invited_by, created_at

invites          id, code, created_by, redeemed_by, redeemed_at,
                 expires_at, created_at

venues           id, name, city, created_by
                 -- seeded with Savaya and Miss Fish; members may add more

table_listings   id, host_id, venue_id, event_name?, starts_at,
                 seats_offered, seat_price_minor, table_total_minor?,
                 notes, payment_link?, payment_note,
                 status(open|cancelled), created_at

seat_requests    id, table_id, user_id, message,
                 status(pending|approved|declined|withdrawn|removed),
                 created_at, decided_at, decided_by

seat_payments    seat_request_id (unique), amount_minor,
                 marked_paid_at, confirmed_at, method, note

email_log        kind, entity_id, to_user_id, sent_at
                 -- unique(kind, entity_id, to_user_id) provides idempotency
```

### Why the host's own cost is absent

`seats_offered` counts guest seats only. Because the seat price is fixed, the app never
needs the table's total to compute anything — so it does not store it as an input.
`table_total_minor` exists only as an optional field a host may fill in to show their math
publicly. It is display-only and participates in no calculation. In a curated community
that transparency has social value; it has no computational value.

## Lifecycle

**Table listings:** the only stored transition is `open → cancelled`.

Two states that look like statuses are *derived*, never stored:

- **Full** — approved seats equal `seats_offered`.
- **Past** — `starts_at` is in the past.

Stored counters and stored time-based flags both drift out of sync with reality, and both
need a job to maintain them. Derived ones cannot drift and need no job.

**Seat requests:** `pending → approved | declined | withdrawn`, and
`approved → removed | withdrawn`. A guest may withdraw at any time before `starts_at`; a
host may remove an approved guest over the same window.

### Editing a listing

A host may freely edit `event_name`, `notes`, `payment_link`, and `payment_note`, and may
raise `seats_offered`.

Once a table has at least one approved seat, `seat_price_minor` and `starts_at` are frozen,
and `seats_offered` cannot be lowered below the approved count. People agreed to a specific
price at a specific time; silently changing either on them is the one thing that would
destroy trust in the product. A host who genuinely needs different terms cancels and
relists.

`seat_payments.amount_minor` records the price at approval time rather than reading the
listing's current price, so the roster stays correct even if a future version relaxes this
rule.

### Invariants

Enforced in the database, not only in application code.

1. **Approved seats never exceed `seats_offered`.** Approval runs inside a transaction that
   takes a row lock on the table listing, counts approved seats, then inserts. A host
   double-tapping approve on two devices cannot oversell the table.
2. **One active request per (user, table)** — a partial unique index where status is
   `pending` or `approved`.
3. **A host cannot request a seat on their own table** — a check constraint.
4. **Cancelling a table cascades:** every approved seat moves to `removed` and every
   affected guest is emailed.

## Notifications

All emails are idempotent through the `email_log` unique constraint, so retries are safe.

| Trigger | Recipient |
|---|---|
| Login | Magic link to the member |
| New table listed | All active members |
| Join request received | Host |
| Request approved | Guest, including the payment link |
| Request declined | Guest |
| Table cancelled, or seat removed | Affected guests |
| Day before the event | Host and all approved guests, with payment status |

The day-before reminder needs a scheduler. DigitalOcean App Platform has no built-in cron,
so a `POST /api/cron/reminders` route guarded by a shared secret is triggered by a GitHub
Actions scheduled workflow. This is deliberately boring and can move to a real scheduler
without touching domain code.

## Screens

| Route | Purpose |
|---|---|
| `/join?code=…` | Redeem an invite and create an account (email, name, Instagram handle) |
| `/login` | Magic link sign-in |
| `/` | Feed of upcoming tables, soonest first, filterable by venue and date |
| `/tables/new` | Host creates a listing |
| `/tables/[id]` | Detail: venue, event, date, price, spots left, host, roster, request to join |
| `/tables/[id]/manage` | Host view: pending requests, roster, payment grid, cancel |
| `/me` | Tables I host, seats I hold, what I owe |
| `/invites` | My invite codes |

## Failure modes

**Approval race.** Two devices approve into the last seat. The row lock makes one fail, and
that host sees "this table just filled up" rather than a 500. This has a dedicated
concurrency test.

**Email is best-effort.** Dispatch happens after the transaction commits, never inside it.
A Resend outage must not roll back a seat approval or block a host. Failures are logged;
the `email_log` unique constraint makes retries safe.

**Stale invite.** An already-redeemed or expired code produces a specific message, not a
generic "invalid".

**Guest withdraws after paying.** The host's payment grid flags "refund owed" and the
system stops there. Because the platform never holds funds, it cannot enforce the refund.
Surfacing it is the honest boundary.

**Host never confirms payment.** Guests see their own "marked paid, awaiting host" state,
so the gap is visible rather than silent.

## Testing

Following test-driven development throughout.

**Domain unit tests (Vitest).** State transitions, invariants, price math. No database, no
framework. Most tests live here, which is the payoff for keeping `lib/domain` free of
framework imports.

**Integration tests against real PostgreSQL** via docker compose, not mocks. Repositories,
the cancel cascade, and specifically a concurrent-approval test proving the oversell guard
holds under real contention.

**Playwright, four paths only.** Invite to signup; create a table; request, approve, mark
paid; cancel cascades. End-to-end tests are slow and brittle — four load-bearing ones beat
forty.

## Success criteria

v1 is working if a host can list a table in under a minute on a phone, a member can find it
and request a seat, the host can approve and see who has paid, and nobody has to open
WhatsApp to make any of that happen.
