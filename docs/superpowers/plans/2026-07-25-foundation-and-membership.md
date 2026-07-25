# Foundation & Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an invite-gated Next.js application on PostgreSQL where an existing member can issue an invite code, a new person can redeem it to create an account, and both can sign in by email magic link.

**Architecture:** Next.js 15 App Router is the entire backend — there is no separate API service. All business logic lives in `lib/domain/*` as plain TypeScript with no framework imports, tested without a database. Persistence sits behind repository interfaces implemented in `lib/db/repositories/*` and tested against real PostgreSQL. Server actions are thin adapters: authenticate, call a domain function, revalidate.

**Tech Stack:** Next.js 15, TypeScript, PostgreSQL 16, Drizzle ORM + drizzle-kit, Auth.js v5 (`next-auth@beta`), Resend, Tailwind CSS, shadcn/ui, Vitest, Docker Compose.

This plan is #1 of 3. It delivers a deployable, working product slice: invite → account → sign in. Plan 2 adds tables and seats; Plan 3 adds settlement and notifications.

**Source spec:** `docs/superpowers/specs/2026-07-25-party-table-splitting-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node.js 20 or newer.** `package.json` sets `"engines": { "node": ">=20" }`.
- **Money is integer rupiah stored as `bigint`.** Never `float`, `real`, `double precision`, or `numeric` with a scale. See "Correction to the spec: money units" below.
- **`lib/domain/**` must not import from `next`, `react`, `next-auth`, `drizzle-orm`, or `@/lib/db`.** Domain code depends only on other domain code and the standard library. Task 1 adds a lint rule that fails the build on violation.
- **No `Date.now()` or `new Date()` inside `lib/domain/**`.** Time enters through an injected `now: () => Date`. Otherwise the logic cannot be tested deterministically.
- **Every database identifier is `snake_case`; every TypeScript identifier is `camelCase`.** Drizzle column definitions carry both, e.g. `instagramHandle: text('instagram_handle')`.
- **Commit messages use Conventional Commits** (`feat:`, `fix:`, `test:`, `chore:`).
- **TDD is mandatory.** Write the failing test, watch it fail for the right reason, then implement. A test that passes the first time you run it is a broken test until proven otherwise.
- **All timestamps are `timestamp with time zone`.** Bali is UTC+8 and the events happen at night; a naive timestamp will eventually put a party on the wrong day.

## Correction to the spec: money units

The spec says money is stored in "integer minor units". Applied literally to IDR this is wrong in two ways, and the plan deviates deliberately.

The rupiah's nominal subunit, the sen, has not circulated since the 1960s. No club prices anything in sen. More importantly, a 25,000,000 IDR table expressed in sen is 2,500,000,000 — which overflows PostgreSQL `integer` (max 2,147,483,647) and would silently corrupt exactly the large-table case this product exists to serve.

**The unit is therefore the rupiah, stored as `bigint`.** Drizzle maps it with `{ mode: 'number' }`, safe to 2^53 — roughly 9 quadrillion rupiah, which is enough. The spec's intent (integers only, no floating-point money) is preserved exactly.

## File structure

```
party/
├─ app/
│  ├─ layout.tsx                        Root layout, fonts, Tailwind
│  ├─ page.tsx                          Placeholder feed (Plan 2 replaces)
│  ├─ login/page.tsx                    Magic-link request form
│  ├─ join/page.tsx                     Invite redemption + account creation
│  ├─ invites/page.tsx                  My invite codes
│  └─ api/auth/[...nextauth]/route.ts   Auth.js handlers
├─ lib/
│  ├─ auth.ts                           Auth.js config (signIn callback gate)
│  ├─ domain/
│  │  ├─ errors.ts                      DomainError + every error code
│  │  ├─ money.ts                       Rupiah formatting and arithmetic
│  │  └─ membership/
│  │     ├─ types.ts                    User, Invite
│  │     ├─ invite-code.ts              Code generation and normalization
│  │     ├─ ports.ts                    MembershipRepository interface
│  │     ├─ redeem-invite.ts            Use case
│  │     └─ issue-invites.ts            Use case
│  └─ db/
│     ├─ client.ts                      Drizzle client singleton
│     ├─ schema/                        One file per table + index.ts
│     └─ repositories/membership.ts     PostgresMembershipRepository
├─ tests/
│  ├─ domain/                           Pure, fast, no database
│  ├─ integration/                      Real PostgreSQL
│  └─ support/                          Fakes and DB helpers
├─ drizzle/                             Generated migrations
├─ docker-compose.yml                   PostgreSQL for dev and tests
├─ drizzle.config.ts
├─ vitest.config.ts                     Domain tests
└─ vitest.integration.config.ts         Integration tests
```

Tests mirror source paths. Domain and integration tests are separate Vitest projects because they have incompatible speed characteristics: domain tests must stay fast enough to run on save, and integration tests must not be allowed to slow them down.

---

### Task 1: Project scaffold, database container, and test harness

Creates the repository skeleton and proves the whole toolchain works end to end by writing one real domain module — the error type every later task depends on.

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `app/globals.css`, `app/layout.tsx`, `app/page.tsx`
- Create: `vitest.config.ts`, `vitest.integration.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore`, `eslint.config.mjs`
- Create: `lib/domain/errors.ts`
- Test: `tests/domain/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class DomainError extends Error` with `readonly code: DomainErrorCode` and `readonly meta?: Record<string, unknown>`; `type DomainErrorCode` (union of string literals); `function isDomainError(e: unknown): e is DomainError`. Every later task throws `DomainError` and never a bare `Error`.

- [ ] **Step 1: Scaffold the Next.js application**

Run in the repository root (the directory already exists and contains `docs/`, so scaffold in place):

```bash
npx create-next-app@latest . \
  --typescript --tailwind --eslint --app \
  --src-dir=false --import-alias="@/*" --use-npm --no-turbopack
```

Answer "yes" to overwriting only if prompted about conflicting files; `docs/` must survive. Verify with `ls docs/superpowers/specs` afterward.

- [ ] **Step 2: Install remaining dependencies**

```bash
npm install drizzle-orm postgres next-auth@beta @auth/drizzle-adapter resend
npm install -D drizzle-kit vitest @vitejs/plugin-react vite-tsconfig-paths dotenv
```

- [ ] **Step 3: Add the PostgreSQL container**

Create `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: party
      POSTGRES_PASSWORD: party
      POSTGRES_DB: party
    ports:
      - "5435:5432"
    volumes:
      - party-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U party"]
      interval: 2s
      timeout: 3s
      retries: 20

volumes:
  party-pgdata:
```

Port 5435 is deliberate. It avoids both a PostgreSQL already running on the host's 5432 and any other project's container on 5433 or 5434 — all three were occupied on the machine this was first run on.

Start it and confirm it is healthy:

```bash
docker compose up -d
docker compose ps
```

Expected: the `db` service shows `healthy`.

- [ ] **Step 4: Create `.env.example` and `.env.local`**

`.env.example` (committed):

```
DATABASE_URL=postgres://party:party@localhost:5435/party
TEST_DATABASE_URL=postgres://party:party@localhost:5435/party_test
AUTH_SECRET=
AUTH_URL=http://localhost:3000
RESEND_API_KEY=
# Resend's shared test sender. It delivers ONLY to the address registered on
# your Resend account. Replace with a verified domain when you have one.
EMAIL_FROM="Party <onboarding@resend.dev>"
CRON_SECRET=
```

Then create the real local file and generate a secret:

```bash
cp .env.example .env.local
npx auth secret
```

Confirm `.gitignore` contains `.env*.local` and `.env`. Add them if `create-next-app` did not.

- [ ] **Step 5: Configure Vitest for domain tests**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/domain/**/*.test.ts'],
  },
})
```

Create `vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/support/db-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
```

`fileParallelism: false` matters: integration tests truncate shared tables, so running files concurrently would make them flake against each other.

Add scripts to `package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 6: Add the domain-purity lint rule**

Append to `eslint.config.mjs`, inside the exported array:

```js
{
  files: ['lib/domain/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['next', 'next/*', 'react', 'react-*'], message: 'Domain code must not import framework modules.' },
        { group: ['drizzle-orm', 'drizzle-orm/*', 'postgres'], message: 'Domain code must not import persistence libraries. Depend on a port interface instead.' },
        { group: ['next-auth', '@auth/*'], message: 'Domain code must not import auth libraries.' },
        { group: ['@/lib/db', '@/lib/db/*', '@/app/*'], message: 'Domain code must not import from the database or app layers.' },
      ],
    }],
  },
},
```

This rule is the load-bearing enforcement of the architecture. Without it, the domain layer erodes within weeks and every later "extract to a service" claim becomes false.

- [ ] **Step 7: Write the failing test for `DomainError`**

Create `tests/domain/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DomainError, isDomainError } from '@/lib/domain/errors'

describe('DomainError', () => {
  it('carries a machine-readable code alongside the message', () => {
    const error = new DomainError('invite_expired', 'This invite expired on 1 August.')

    expect(error.code).toBe('invite_expired')
    expect(error.message).toBe('This invite expired on 1 August.')
  })

  it('is a real Error, so stack traces and instanceof both work', () => {
    const error = new DomainError('invite_not_found', 'No such code.')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('DomainError')
    expect(error.stack).toBeDefined()
  })

  it('optionally carries structured metadata for the UI to render', () => {
    const error = new DomainError('invite_expired', 'Expired.', { expiredAt: '2026-08-01' })

    expect(error.meta).toEqual({ expiredAt: '2026-08-01' })
  })

  it('narrows unknown values through isDomainError', () => {
    expect(isDomainError(new DomainError('invite_not_found', 'x'))).toBe(true)
    expect(isDomainError(new Error('plain'))).toBe(false)
    expect(isDomainError('not an error')).toBe(false)
    expect(isDomainError(null)).toBe(false)
  })
})
```

- [ ] **Step 8: Run the test and confirm it fails for the right reason**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/errors` — "Failed to resolve import". If it fails for any other reason (for example a Vitest config error), fix that first; a test failing for the wrong reason proves nothing.

- [ ] **Step 9: Implement `DomainError`**

Create `lib/domain/errors.ts`:

```ts
/**
 * Every error code the domain layer can produce.
 *
 * Codes are declared up front, including ones no use case throws yet, so that
 * adapters can exhaustively map codes to user-facing copy in one place rather
 * than discovering new codes at runtime.
 */
export type DomainErrorCode =
  // membership
  | 'invite_not_found'
  | 'invite_expired'
  | 'invite_already_redeemed'
  | 'invite_quota_exhausted'
  | 'email_already_registered'
  | 'user_suspended'
  // listings (Plan 2)
  | 'listing_not_found'
  | 'listing_cancelled'
  | 'listing_past'
  | 'listing_locked'
  | 'not_listing_host'
  // seats (Plan 2)
  | 'table_full'
  | 'duplicate_seat_request'
  | 'host_cannot_join_own_table'
  | 'seat_request_not_found'
  | 'seat_request_already_decided'
  // shared
  | 'invalid_amount'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError
}
```

- [ ] **Step 10: Run the test and confirm it passes**

```bash
npm test
```

Expected: 4 passing tests.

- [ ] **Step 11: Verify the lint rule actually fires**

Temporarily add `import { NextResponse } from 'next/server'` to the top of `lib/domain/errors.ts`, then:

```bash
npm run lint
```

Expected: an error reading "Domain code must not import framework modules." **Remove the import** and re-run `npm run lint` to confirm it is clean. A guardrail you never watched fail is not a guardrail.

- [ ] **Step 12: Verify the app boots**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js app, Postgres container, and domain error type"
```

---

### Task 2: Rupiah money module

Money formatting is where sloppiness becomes visible to users, and locale-dependent formatting is a classic source of flaky tests. This module is deliberately hand-rolled and locale-independent.

**Files:**
- Create: `lib/domain/money.ts`
- Test: `tests/domain/money.test.ts`

**Interfaces:**
- Consumes: `DomainError` from Task 1.
- Produces: `type Rupiah = number`; `formatRupiah(amount: Rupiah): string`; `parseRupiah(input: string): Rupiah`; `multiplyRupiah(amount: Rupiah, quantity: number): Rupiah`. All later tasks format money exclusively through `formatRupiah`.

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/money.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatRupiah, multiplyRupiah, parseRupiah } from '@/lib/domain/money'
import { DomainError } from '@/lib/domain/errors'

describe('formatRupiah', () => {
  it('groups thousands with dots, the Indonesian convention', () => {
    expect(formatRupiah(2_500_000)).toBe('Rp 2.500.000')
    expect(formatRupiah(25_000_000)).toBe('Rp 25.000.000')
  })

  it('formats small and zero amounts without stray separators', () => {
    expect(formatRupiah(0)).toBe('Rp 0')
    expect(formatRupiah(500)).toBe('Rp 500')
    expect(formatRupiah(1_000)).toBe('Rp 1.000')
  })

  it('formats negative amounts with the sign outside the currency symbol', () => {
    expect(formatRupiah(-1_500_000)).toBe('-Rp 1.500.000')
  })

  it('rejects non-integer amounts rather than rounding silently', () => {
    expect(() => formatRupiah(1500.5)).toThrow(DomainError)
  })
})

describe('parseRupiah', () => {
  it('accepts the format it produces, round-tripping exactly', () => {
    expect(parseRupiah('Rp 2.500.000')).toBe(2_500_000)
    expect(parseRupiah(formatRupiah(17_250_000))).toBe(17_250_000)
  })

  it('accepts what a human actually types', () => {
    expect(parseRupiah('2500000')).toBe(2_500_000)
    expect(parseRupiah('2.500.000')).toBe(2_500_000)
    expect(parseRupiah('2,500,000')).toBe(2_500_000)
    expect(parseRupiah('  Rp 2 500 000  ')).toBe(2_500_000)
  })

  it('rejects input that is not a whole amount of rupiah', () => {
    for (const bad of ['', 'Rp', 'abc', '2500.50', '-100', '1e6']) {
      expect(() => parseRupiah(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrow(DomainError)
    }
  })

  it('reports rejection with the invalid_amount code', () => {
    try {
      parseRupiah('abc')
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('invalid_amount')
    }
  })
})

describe('multiplyRupiah', () => {
  it('computes a table total from seat price and seat count', () => {
    expect(multiplyRupiah(2_500_000, 8)).toBe(20_000_000)
    expect(multiplyRupiah(2_500_000, 0)).toBe(0)
  })

  it('rejects a fractional or negative quantity', () => {
    expect(() => multiplyRupiah(2_500_000, 1.5)).toThrow(DomainError)
    expect(() => multiplyRupiah(2_500_000, -1)).toThrow(DomainError)
  })

  it('rejects results beyond safe integer precision instead of losing rupiah', () => {
    expect(() => multiplyRupiah(Number.MAX_SAFE_INTEGER, 2)).toThrow(DomainError)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/money`.

- [ ] **Step 3: Implement the module**

Create `lib/domain/money.ts`:

```ts
import { DomainError } from './errors'

/**
 * An amount of Indonesian rupiah, always a whole number.
 *
 * The rupiah's nominal subunit (sen) has not circulated for decades and no
 * venue prices in it, so the rupiah itself is the storage unit. Persisted as
 * `bigint` because a large table in sen would overflow a 32-bit integer.
 */
export type Rupiah = number

function assertWholeRupiah(amount: number): void {
  if (!Number.isInteger(amount)) {
    throw new DomainError('invalid_amount', 'Amounts must be a whole number of rupiah.', { amount })
  }
  if (!Number.isSafeInteger(amount)) {
    throw new DomainError('invalid_amount', 'Amount is too large to represent exactly.', { amount })
  }
}

export function formatRupiah(amount: Rupiah): string {
  assertWholeRupiah(amount)

  const sign = amount < 0 ? '-' : ''
  const grouped = Math.abs(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')

  return `${sign}Rp ${grouped}`
}

export function parseRupiah(input: string): Rupiah {
  // Strip the currency symbol and every separator a person might type or paste.
  const digits = input.trim().replace(/^Rp/i, '').replace(/[.,\s ]/g, '')

  if (!/^\d+$/.test(digits)) {
    throw new DomainError('invalid_amount', 'Enter a whole amount in rupiah, for example 2.500.000.', { input })
  }

  const amount = Number(digits)
  assertWholeRupiah(amount)
  return amount
}

export function multiplyRupiah(amount: Rupiah, quantity: number): Rupiah {
  assertWholeRupiah(amount)

  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new DomainError('invalid_amount', 'Quantity must be a whole number of seats, zero or more.', { quantity })
  }

  const total = amount * quantity
  assertWholeRupiah(total)
  return total
}
```

Note that `parseRupiah` strips `.` and `,` identically. Indonesian uses `.` for thousands, English uses `,`, and both appear in pasted numbers. Because fractional rupiah are rejected outright, treating both as noise cannot misread a decimal point — `'2500.50'` fails the digit check rather than silently becoming 250,050.

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npm test
```

Expected: all money and error tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/money.ts tests/domain/money.test.ts
git commit -m "feat: add rupiah formatting, parsing, and multiplication"
```

---

### Task 3: Database schema and migrations

Creates every table in the spec, not only the membership ones. Schema is cohesive: a single baseline migration is far easier to reason about than seven incremental ones, and Plan 2 should not have to reopen the foundation.

**Files:**
- Create: `drizzle.config.ts`, `lib/db/client.ts`
- Create: `lib/db/schema/{users,auth,invites,venues,table-listings,seat-requests,seat-payments,email-log,index}.ts`
- Create: `drizzle/` migration output (generated)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `db` (Drizzle client) from `@/lib/db/client`; all table objects re-exported from `@/lib/db/schema` — `users`, `accounts`, `sessions`, `verificationTokens`, `invites`, `venues`, `tableListings`, `seatRequests`, `seatPayments`, `emailLog`.

- [ ] **Step 1: Configure drizzle-kit**

Create `drizzle.config.ts`:

```ts
import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './lib/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

- [ ] **Step 2: Define the users and Auth.js tables**

Create `lib/db/schema/users.ts`:

```ts
import { pgEnum, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

export const userStatus = pgEnum('user_status', ['active', 'suspended'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  instagramHandle: text('instagram_handle'),
  image: text('image'),
  // Auth.js writes this column; it is not our application state.
  emailVerified: timestamp('email_verified', { withTimezone: true }),
  status: userStatus('status').notNull().default('active'),
  invitedBy: uuid('invited_by').references((): AnyPgColumn => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

`invitedBy` is self-referential, which is why it needs the explicit `AnyPgColumn` return type — TypeScript cannot otherwise infer a type that refers to itself. The founding member's `invitedBy` is null, which is exactly why the column is nullable.

Create `lib/db/schema/auth.ts`:

```ts
import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { AdapterAccountType } from 'next-auth/adapters'
import { users } from './users'

// Shapes required by @auth/drizzle-adapter. Do not add application columns here.
export const accounts = pgTable('accounts', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').$type<AdapterAccountType>().notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
}, (table) => [
  primaryKey({ columns: [table.provider, table.providerAccountId] }),
])

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
})

export const verificationTokens = pgTable('verification_tokens', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.identifier, table.token] }),
])
```

The snake_case-versus-camelCase inconsistency in `accounts` (`refresh_token`, not `refreshToken`) is not a mistake — the Auth.js adapter reads those exact property names. This table is the one place the global naming rule yields to a library contract.

- [ ] **Step 3: Define the invites and venues tables**

Create `lib/db/schema/invites.ts`:

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  redeemedBy: uuid('redeemed_by').references(() => users.id),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

Create `lib/db/schema/venues.ts`:

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const venues = pgTable('venues', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

`createdBy` is nullable so that seeded venues (Savaya, Miss Fish) can exist without belonging to a member.

- [ ] **Step 4: Define the table listings**

Create `lib/db/schema/table-listings.ts`:

```ts
import { sql } from 'drizzle-orm'
import { bigint, check, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import { venues } from './venues'

export const listingStatus = pgEnum('listing_status', ['open', 'cancelled'])

export const tableListings = pgTable('table_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  hostId: uuid('host_id').notNull().references(() => users.id),
  venueId: uuid('venue_id').notNull().references(() => venues.id),
  eventName: text('event_name'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  seatsOffered: integer('seats_offered').notNull(),
  seatPrice: bigint('seat_price', { mode: 'number' }).notNull(),
  tableTotal: bigint('table_total', { mode: 'number' }),
  notes: text('notes'),
  paymentLink: text('payment_link'),
  paymentNote: text('payment_note'),
  status: listingStatus('status').notNull().default('open'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('seats_offered_positive', sql`${table.seatsOffered} > 0`),
  check('seat_price_non_negative', sql`${table.seatPrice} >= 0`),
  // Enables the composite foreign key on seat_requests in the next step.
  unique('table_listings_id_host_key').on(table.id, table.hostId),
])
```

There is no `completed` status. Per the spec, "past" is derived from `startsAt` and "full" is derived from the approved-seat count. Neither is stored, so neither can drift and neither needs a job to maintain it.

- [ ] **Step 5: Define seat requests, with the host-cannot-join rule enforced structurally**

Create `lib/db/schema/seat-requests.ts`:

```ts
import { sql } from 'drizzle-orm'
import { check, foreignKey, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tableListings } from './table-listings'
import { users } from './users'

export const seatRequestStatus = pgEnum('seat_request_status', [
  'pending', 'approved', 'declined', 'withdrawn', 'removed',
])

export const seatRequests = pgTable('seat_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tableId: uuid('table_id').notNull().references(() => tableListings.id),
  // Denormalized copy of the listing's host, kept honest by the composite FK
  // below. Present solely so the "host cannot join own table" rule can be a
  // CHECK constraint: a CHECK cannot reference another table.
  hostId: uuid('host_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id),
  message: text('message'),
  status: seatRequestStatus('status').notNull().default('pending'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: 'seat_requests_table_host_fk',
    columns: [table.tableId, table.hostId],
    foreignColumns: [tableListings.id, tableListings.hostId],
  }),
  check('seat_request_user_is_not_host', sql`${table.userId} <> ${table.hostId}`),
  uniqueIndex('one_active_seat_request_per_user_per_table')
    .on(table.tableId, table.userId)
    .where(sql`status in ('pending', 'approved')`),
])
```

This is a deliberate correction to the spec, which called invariant 3 a plain check constraint. PostgreSQL `CHECK` cannot reference another table, so `seat_requests.user_id <> table_listings.host_id` is not directly expressible. Copying `host_id` onto the row and tying it back with a composite foreign key makes the constraint local — and the FK guarantees the copy can never disagree with the listing.

The partial unique index is invariant 2: at most one `pending` or `approved` request per person per table, while any number of `declined` or `withdrawn` rows may accumulate as history.

- [ ] **Step 6: Define seat payments and the email log**

Create `lib/db/schema/seat-payments.ts`:

```ts
import { sql } from 'drizzle-orm'
import { bigint, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { seatRequests } from './seat-requests'
import { users } from './users'

export const seatPayments = pgTable('seat_payments', {
  seatRequestId: uuid('seat_request_id').primaryKey().references(() => seatRequests.id, { onDelete: 'cascade' }),
  // Price captured at approval time, not read from the listing, so the roster
  // stays correct even if a future version allows repricing.
  amount: bigint('amount', { mode: 'number' }).notNull(),
  markedPaidAt: timestamp('marked_paid_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  confirmedBy: uuid('confirmed_by').references(() => users.id),
  method: text('method'),
  note: text('note'),
}, (table) => [
  check('seat_payment_amount_non_negative', sql`${table.amount} >= 0`),
])
```

Create `lib/db/schema/email-log.ts`:

```ts
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const emailLog = pgTable('email_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  entityId: uuid('entity_id').notNull(),
  toUserId: uuid('to_user_id').notNull().references(() => users.id),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('email_log_once_per_recipient').on(table.kind, table.entityId, table.toUserId),
])
```

That unique constraint is the whole idempotency mechanism: an insert that violates it means the email already went out, so the send is skipped rather than duplicated.

- [ ] **Step 7: Create the schema barrel and database client**

Create `lib/db/schema/index.ts`:

```ts
export * from './users'
export * from './auth'
export * from './invites'
export * from './venues'
export * from './table-listings'
export * from './seat-requests'
export * from './seat-payments'
export * from './email-log'
```

Create `lib/db/client.ts`:

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

// Next.js dev mode re-evaluates modules on every hot reload; without this the
// process leaks a connection pool per reload until Postgres refuses new ones.
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> }

const client = globalForDb.pgClient ?? postgres(connectionString, { max: 10 })
if (process.env.NODE_ENV !== 'production') globalForDb.pgClient = client

export const db = drizzle(client, { schema })
export type Db = typeof db
```

- [ ] **Step 8: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
```

Expected: a new SQL file under `drizzle/` and a successful apply.

- [ ] **Step 9: Verify the constraints exist in the actual database**

Do not trust the generated SQL by reading it. Query the live schema:

```bash
docker compose exec -T db psql -U party -d party -c "\d seat_requests"
```

Expected output must include all three of:
- `"one_active_seat_request_per_user_per_table" UNIQUE, btree (table_id, user_id) WHERE status = ANY (ARRAY['pending'::seat_request_status, 'approved'::seat_request_status])`
- `Check constraints: "seat_request_user_is_not_host" CHECK (user_id <> host_id)`
- `Foreign-key constraints: "seat_requests_table_host_fk" FOREIGN KEY (table_id, host_id) REFERENCES table_listings(id, host_id)`

If the partial index lost its `WHERE` clause, the schema is wrong and Plan 2's approval logic will break in a way that is very hard to diagnose later. Fix it before continuing.

- [ ] **Step 10: Commit**

```bash
git add drizzle.config.ts lib/db drizzle
git commit -m "feat: add database schema and baseline migration"
```

---

### Task 4: Invite code generation

**Files:**
- Create: `lib/domain/membership/invite-code.ts`
- Test: `tests/domain/membership/invite-code.test.ts`

**Interfaces:**
- Consumes: `DomainError` from Task 1.
- Produces: `generateInviteCode(random?: () => number): string` returning `XXXX-XXXX`; `normalizeInviteCode(input: string): string` returning the canonical dashed form; `INVITE_CODE_ALPHABET: string`.

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/membership/invite-code.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { INVITE_CODE_ALPHABET, generateInviteCode, normalizeInviteCode } from '@/lib/domain/membership/invite-code'
import { DomainError } from '@/lib/domain/errors'

describe('generateInviteCode', () => {
  it('produces a dashed eight-character code', () => {
    expect(generateInviteCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })

  it('never emits characters that are misread when spoken or typed', () => {
    for (const forbidden of ['I', 'L', 'O', '0', '1']) {
      expect(INVITE_CODE_ALPHABET).not.toContain(forbidden)
    }

    const codes = Array.from({ length: 200 }, () => generateInviteCode())
    for (const code of codes) {
      for (const char of code.replace('-', '')) {
        expect(INVITE_CODE_ALPHABET).toContain(char)
      }
    }
  })

  it('is deterministic when given a deterministic source of randomness', () => {
    const alwaysZero = () => 0
    const first = INVITE_CODE_ALPHABET[0]

    expect(generateInviteCode(alwaysZero)).toBe(`${first.repeat(4)}-${first.repeat(4)}`)
  })

  it('does not collide across a realistic number of draws', () => {
    const codes = new Set(Array.from({ length: 5_000 }, () => generateInviteCode()))
    expect(codes.size).toBe(5_000)
  })
})

describe('normalizeInviteCode', () => {
  it('accepts the canonical form unchanged', () => {
    expect(normalizeInviteCode('ABCD-EFGH')).toBe('ABCD-EFGH')
  })

  it('repairs how people actually retype a code', () => {
    expect(normalizeInviteCode('abcd-efgh')).toBe('ABCD-EFGH')
    expect(normalizeInviteCode('ABCDEFGH')).toBe('ABCD-EFGH')
    expect(normalizeInviteCode('  abcd efgh ')).toBe('ABCD-EFGH')
    expect(normalizeInviteCode('ABCD–EFGH')).toBe('ABCD-EFGH') // en dash from iOS autocorrect
  })

  it('rejects anything that cannot be a code', () => {
    for (const bad of ['', 'ABC', 'ABCDEFGHI', 'ABCD-EFG!', 'ABCI-EFGH']) {
      expect(() => normalizeInviteCode(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrow(DomainError)
    }
  })

  it('reports rejection as invite_not_found, not a separate validation error', () => {
    try {
      normalizeInviteCode('nope')
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as DomainError).code).toBe('invite_not_found')
    }
  })
})
```

The last test encodes a decision worth stating: a malformed code and a nonexistent code produce the same error, because to the person typing it there is no difference, and distinguishing them would tell an attacker which codes are well-formed.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/membership/invite-code`.

- [ ] **Step 3: Implement**

Create `lib/domain/membership/invite-code.ts`:

```ts
import { DomainError } from '../errors'

/** Crockford-style alphabet: no I, L, O, 0, or 1, which people confuse when reading a code aloud. */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

const CODE_LENGTH = 8

export function generateInviteCode(random: () => number = Math.random): string {
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    const index = Math.floor(random() * INVITE_CODE_ALPHABET.length)
    raw += INVITE_CODE_ALPHABET[index]
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

export function normalizeInviteCode(input: string): string {
  const stripped = input
    .toUpperCase()
    .replace(/[\s‐-―-]/g, '') // spaces, hyphen, and the dash variants iOS substitutes

  const isValid =
    stripped.length === CODE_LENGTH &&
    [...stripped].every((char) => INVITE_CODE_ALPHABET.includes(char))

  if (!isValid) {
    // Deliberately identical to the "no such invite" error: the person typing
    // cannot act on the difference, and separating them leaks which codes are
    // well-formed to anyone guessing.
    throw new DomainError('invite_not_found', "That invite code doesn't look right. Check it and try again.")
  }

  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npm test
```

Expected: all invite-code tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/membership/invite-code.ts tests/domain/membership/invite-code.test.ts
git commit -m "feat: add invite code generation and normalization"
```

---

### Task 5: Membership ports and use cases

The heart of the plan. Two use cases, tested entirely against an in-memory fake — no database, no framework, milliseconds to run.

**Files:**
- Create: `lib/domain/membership/types.ts`, `lib/domain/membership/ports.ts`
- Create: `lib/domain/membership/redeem-invite.ts`, `lib/domain/membership/issue-invites.ts`
- Create: `tests/support/fake-membership-repository.ts`
- Test: `tests/domain/membership/redeem-invite.test.ts`, `tests/domain/membership/issue-invites.test.ts`

**Interfaces:**
- Consumes: `DomainError` (Task 1), `generateInviteCode`/`normalizeInviteCode` (Task 4).
- Produces:
  - `interface User { id, email, name, instagramHandle, status, invitedBy, createdAt }`
  - `interface Invite { id, code, createdBy, redeemedBy, redeemedAt, expiresAt, createdAt }`
  - `interface MembershipRepository` — the port Task 6 implements against PostgreSQL.
  - `redeemInvite(deps: MembershipDeps, input: RedeemInviteInput): Promise<User>`
  - `issueInvites(deps: MembershipDeps, input: IssueInvitesInput): Promise<Invite[]>`
  - `INVITE_QUOTA = 3`, `INVITE_TTL_DAYS = 30`

- [ ] **Step 1: Define types and ports**

Create `lib/domain/membership/types.ts`:

```ts
export type UserStatus = 'active' | 'suspended'

export interface User {
  id: string
  email: string
  name: string
  instagramHandle: string | null
  status: UserStatus
  invitedBy: string | null
  createdAt: Date
}

export interface Invite {
  id: string
  code: string
  createdBy: string
  redeemedBy: string | null
  redeemedAt: Date | null
  expiresAt: Date
  createdAt: Date
}
```

Create `lib/domain/membership/ports.ts`:

```ts
import type { Invite, User } from './types'

export interface NewUser {
  email: string
  name: string
  instagramHandle: string | null
  invitedBy: string
}

export interface MembershipRepository {
  findUserByEmail(email: string): Promise<User | null>
  findInviteByCode(code: string): Promise<Invite | null>
  listInvitesCreatedBy(userId: string): Promise<Invite[]>

  /**
   * Atomically: claim the invite if and only if it is still unredeemed, create
   * the user, and stamp the invite with the new user's id.
   *
   * `redeemedAt` is the authoritative claim marker, not `redeemedBy`. The
   * claim has to happen before the user exists, and `redeemedBy` carries a
   * foreign key to users.id, so it cannot be written first.
   *
   * Returns null if the invite was already claimed — by a concurrent caller or
   * otherwise. Callers MUST treat null as "already redeemed" rather than
   * checking redemption separately, because any check performed before this
   * call is stale by the time it returns.
   */
  claimInviteAndCreateUser(inviteId: string, user: NewUser): Promise<User | null>

  insertInvites(invites: Array<{ code: string; createdBy: string; expiresAt: Date }>): Promise<Invite[]>
}

export interface MembershipDeps {
  repository: MembershipRepository
  now: () => Date
  generateCode?: () => string
}
```

The doc comment on `claimInviteAndCreateUser` is the important part of this file. The check-then-act race is the single most likely bug in this feature, and the port's contract is where it gets designed out.

- [ ] **Step 2: Write the failing tests for redeeming an invite**

Create `tests/domain/membership/redeem-invite.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { redeemInvite } from '@/lib/domain/membership/redeem-invite'
import { DomainError } from '@/lib/domain/errors'
import { FakeMembershipRepository } from '../../support/fake-membership-repository'

const NOW = new Date('2026-08-01T12:00:00Z')
const deps = (repository: FakeMembershipRepository) => ({ repository, now: () => NOW })

let repository: FakeMembershipRepository
let hostId: string

beforeEach(() => {
  repository = new FakeMembershipRepository()
  hostId = repository.seedUser({ email: 'host@example.com', name: 'Host' }).id
})

describe('redeemInvite', () => {
  it('creates an active member linked to whoever invited them', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const user = await redeemInvite(deps(repository), {
      code: 'ABCD-EFGH',
      email: 'new@example.com',
      name: 'New Member',
      instagramHandle: '@newmember',
    })

    expect(user.email).toBe('new@example.com')
    expect(user.name).toBe('New Member')
    expect(user.instagramHandle).toBe('@newmember')
    expect(user.status).toBe('active')
    expect(user.invitedBy).toBe(hostId)
  })

  it('marks the invite as redeemed by the new member', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const user = await redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })

    const invite = await repository.findInviteByCode('ABCD-EFGH')
    expect(invite!.redeemedBy).toBe(user.id)
    expect(invite!.redeemedAt).toEqual(NOW)
  })

  it('accepts a code however the person retyped it', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const user = await redeemInvite(deps(repository), {
      code: '  abcdefgh ', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })

    expect(user.email).toBe('new@example.com')
  })

  it('normalizes the email so casing cannot create a duplicate account', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const user = await redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: '  New@Example.COM ', name: 'New Member', instagramHandle: null,
    })

    expect(user.email).toBe('new@example.com')
  })

  it('rejects a code that does not exist', async () => {
    await expect(redeemInvite(deps(repository), {
      code: 'ZZZZ-ZZZZ', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'invite_not_found' })
  })

  it('rejects an expired code, and says when it expired', async () => {
    const expiredAt = new Date('2026-07-01T00:00:00Z')
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: expiredAt })

    try {
      await redeemInvite(deps(repository), {
        code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('invite_expired')
      expect((error as DomainError).meta).toEqual({ expiredAt })
    }
  })

  it('treats a code expiring exactly now as still valid', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: NOW })

    const user = await redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })

    expect(user.email).toBe('new@example.com')
  })

  it('rejects a code someone else already used', async () => {
    const otherId = repository.seedUser({ email: 'other@example.com', name: 'Other' }).id
    repository.seedInvite({
      code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z'),
      redeemedBy: otherId, redeemedAt: new Date('2026-07-15T00:00:00Z'),
    })

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'invite_already_redeemed' })
  })

  it('rejects an email that already has an account', async () => {
    repository.seedUser({ email: 'taken@example.com', name: 'Existing' })
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'taken@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'email_already_registered' })
  })

  it('leaves the invite unredeemed when the email is already taken', async () => {
    repository.seedUser({ email: 'taken@example.com', name: 'Existing' })
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'taken@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toThrow()

    const invite = await repository.findInviteByCode('ABCD-EFGH')
    expect(invite!.redeemedBy).toBeNull()
  })

  it('rejects a blank name rather than creating a nameless member', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: '   ', instagramHandle: null,
    })).rejects.toBeInstanceOf(DomainError)
  })

  it('surfaces a lost race as invite_already_redeemed', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })
    repository.failNextClaim = true

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'invite_already_redeemed' })
  })
})
```

- [ ] **Step 3: Write the fake repository**

Create `tests/support/fake-membership-repository.ts`:

```ts
import type { MembershipRepository, NewUser } from '@/lib/domain/membership/ports'
import type { Invite, User } from '@/lib/domain/membership/types'

let counter = 0
const nextId = (prefix: string) => `${prefix}-${++counter}`

export class FakeMembershipRepository implements MembershipRepository {
  users: User[] = []
  invites: Invite[] = []
  /** Simulates losing the claim race to a concurrent redeemer. */
  failNextClaim = false

  seedUser(partial: { email: string; name: string; invitedBy?: string | null }): User {
    const user: User = {
      id: nextId('user'),
      email: partial.email.trim().toLowerCase(),
      name: partial.name,
      instagramHandle: null,
      status: 'active',
      invitedBy: partial.invitedBy ?? null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    this.users.push(user)
    return user
  }

  seedInvite(partial: {
    code: string; createdBy: string; expiresAt: Date
    redeemedBy?: string; redeemedAt?: Date
  }): Invite {
    const invite: Invite = {
      id: nextId('invite'),
      code: partial.code,
      createdBy: partial.createdBy,
      redeemedBy: partial.redeemedBy ?? null,
      redeemedAt: partial.redeemedAt ?? null,
      expiresAt: partial.expiresAt,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    this.invites.push(invite)
    return invite
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null
  }

  async findInviteByCode(code: string): Promise<Invite | null> {
    return this.invites.find((i) => i.code === code) ?? null
  }

  async listInvitesCreatedBy(userId: string): Promise<Invite[]> {
    return this.invites.filter((i) => i.createdBy === userId)
  }

  async claimInviteAndCreateUser(inviteId: string, newUser: NewUser): Promise<User | null> {
    if (this.failNextClaim) {
      this.failNextClaim = false
      return null
    }

    const invite = this.invites.find((i) => i.id === inviteId)
    if (!invite || invite.redeemedAt !== null) return null

    const user = this.seedUser({
      email: newUser.email,
      name: newUser.name,
      invitedBy: newUser.invitedBy,
    })
    user.instagramHandle = newUser.instagramHandle

    invite.redeemedBy = user.id
    invite.redeemedAt = this.claimTime
    return user
  }

  /** Set by tests that assert on redeemedAt. */
  claimTime = new Date('2026-08-01T12:00:00Z')

  async insertInvites(rows: Array<{ code: string; createdBy: string; expiresAt: Date }>): Promise<Invite[]> {
    return rows.map((row) => this.seedInvite(row))
  }
}
```

- [ ] **Step 4: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/membership/redeem-invite`.

- [ ] **Step 5: Implement `redeemInvite`**

Create `lib/domain/membership/redeem-invite.ts`:

```ts
import { DomainError } from '../errors'
import { normalizeInviteCode } from './invite-code'
import type { MembershipDeps } from './ports'
import type { User } from './types'

export interface RedeemInviteInput {
  code: string
  email: string
  name: string
  instagramHandle: string | null
}

export async function redeemInvite(deps: MembershipDeps, input: RedeemInviteInput): Promise<User> {
  const { repository, now } = deps

  const code = normalizeInviteCode(input.code)
  const email = input.email.trim().toLowerCase()
  const name = input.name.trim()

  if (name.length === 0) {
    throw new DomainError('invalid_amount', 'Enter your name so hosts know who is asking for a seat.')
  }

  const invite = await repository.findInviteByCode(code)
  if (!invite) {
    throw new DomainError('invite_not_found', "That invite code doesn't look right. Check it and try again.")
  }

  // redeemedAt, not redeemedBy: the claim is stamped on redeemedAt first and
  // redeemedBy is backfilled microseconds later. See MembershipRepository.
  if (invite.redeemedAt !== null) {
    throw new DomainError('invite_already_redeemed', 'That invite has already been used.')
  }

  if (invite.expiresAt.getTime() < now().getTime()) {
    throw new DomainError('invite_expired', 'That invite has expired. Ask for a fresh one.', {
      expiredAt: invite.expiresAt,
    })
  }

  if (await repository.findUserByEmail(email)) {
    throw new DomainError('email_already_registered', 'There is already an account for that email. Sign in instead.')
  }

  const user = await repository.claimInviteAndCreateUser(invite.id, {
    email,
    name,
    instagramHandle: input.instagramHandle?.trim() || null,
    invitedBy: invite.createdBy,
  })

  // The checks above are advisory: they exist to produce good error messages.
  // This is the authoritative one. A null return means another redemption won
  // the race between our check and our claim.
  if (!user) {
    throw new DomainError('invite_already_redeemed', 'That invite has already been used.')
  }

  return user
}
```

Note the `invalid_amount` code on the blank-name check — that code is a poor fit and Task 5 Step 9 fixes it. It is written this way deliberately so the fix is a real, observed refactor rather than a claim.

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npm test
```

Expected: all `redeemInvite` tests pass. If the `redeemedAt` assertion fails, set `repository.claimTime = NOW` in the fake's constructor — the values must agree.

- [ ] **Step 7: Write the failing tests for issuing invites**

Create `tests/domain/membership/issue-invites.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { INVITE_QUOTA, INVITE_TTL_DAYS, issueInvites } from '@/lib/domain/membership/issue-invites'
import { FakeMembershipRepository } from '../../support/fake-membership-repository'

const NOW = new Date('2026-08-01T12:00:00Z')

let repository: FakeMembershipRepository
let memberId: string

const deps = (overrides: Partial<{ generateCode: () => string }> = {}) => ({
  repository,
  now: () => NOW,
  ...overrides,
})

beforeEach(() => {
  repository = new FakeMembershipRepository()
  memberId = repository.seedUser({ email: 'member@example.com', name: 'Member' }).id
})

describe('issueInvites', () => {
  it('gives a brand-new member their full quota', async () => {
    const invites = await issueInvites(deps(), { userId: memberId })

    expect(invites).toHaveLength(INVITE_QUOTA)
    expect(INVITE_QUOTA).toBe(3)
  })

  it('sets every code to expire after the configured window', async () => {
    const [invite] = await issueInvites(deps(), { userId: memberId })

    const expectedExpiry = new Date(NOW.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)
    expect(invite.expiresAt).toEqual(expectedExpiry)
    expect(INVITE_TTL_DAYS).toBe(30)
  })

  it('is idempotent: a member who already holds their quota gets nothing new', async () => {
    await issueInvites(deps(), { userId: memberId })
    const second = await issueInvites(deps(), { userId: memberId })

    expect(second).toHaveLength(0)
    expect(repository.invites).toHaveLength(INVITE_QUOTA)
  })

  it('tops a member up only to the quota, never past it', async () => {
    repository.seedInvite({ code: 'AAAA-AAAA', createdBy: memberId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const issued = await issueInvites(deps(), { userId: memberId })

    expect(issued).toHaveLength(INVITE_QUOTA - 1)
  })

  it('does not replenish codes that were spent', async () => {
    const guestId = repository.seedUser({ email: 'guest@example.com', name: 'Guest' }).id
    for (let i = 0; i < INVITE_QUOTA; i++) {
      repository.seedInvite({
        code: `AAA${i}-AAAA`, createdBy: memberId,
        expiresAt: new Date('2026-09-01T00:00:00Z'),
        redeemedBy: guestId, redeemedAt: NOW,
      })
    }

    const issued = await issueInvites(deps(), { userId: memberId })

    expect(issued).toHaveLength(0)
  })

  it('does not count expired codes toward the quota', async () => {
    repository.seedInvite({ code: 'AAAA-AAAA', createdBy: memberId, expiresAt: new Date('2026-07-01T00:00:00Z') })

    const issued = await issueInvites(deps(), { userId: memberId })

    expect(issued).toHaveLength(INVITE_QUOTA)
  })

  it('retries when a generated code collides with an existing one', async () => {
    repository.seedInvite({ code: 'DUPE-DUPE', createdBy: memberId, expiresAt: new Date('2026-07-01T00:00:00Z') })

    const sequence = ['DUPE-DUPE', 'AAAA-AAAA', 'BBBB-BBBB', 'CCCC-CCCC']
    let index = 0
    const invites = await issueInvites(deps({ generateCode: () => sequence[index++] }), { userId: memberId })

    expect(invites.map((i) => i.code)).toEqual(['AAAA-AAAA', 'BBBB-BBBB', 'CCCC-CCCC'])
  })
})
```

The distinction between the "does not replenish spent codes" test and the "does not count expired codes" test is the product rule from the spec: spent codes are a deliberate throttle on growth, expired ones are just waste.

- [ ] **Step 8: Run the tests, confirm they fail, then implement**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/membership/issue-invites`.

Create `lib/domain/membership/issue-invites.ts`:

```ts
import { generateInviteCode } from './invite-code'
import type { MembershipDeps } from './ports'
import type { Invite } from './types'

/** Codes each active member holds at once. A deliberate throttle on growth, not a technical limit. */
export const INVITE_QUOTA = 3

export const INVITE_TTL_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface IssueInvitesInput {
  userId: string
}

/**
 * Top a member up to their quota of live, unredeemed codes.
 *
 * Idempotent: calling it repeatedly is safe, so a page render can call it
 * without needing to know whether the member has been topped up before.
 *
 * Redeemed codes are NOT replaced. Growth rate is something to watch
 * deliberately before automating.
 */
export async function issueInvites(deps: MembershipDeps, input: IssueInvitesInput): Promise<Invite[]> {
  const { repository, now, generateCode = generateInviteCode } = deps

  const existing = await repository.listInvitesCreatedBy(input.userId)
  const taken = new Set(existing.map((invite) => invite.code))

  const live = existing.filter(
    (invite) => invite.redeemedAt === null && invite.expiresAt.getTime() >= now().getTime(),
  )

  const shortfall = INVITE_QUOTA - live.length
  if (shortfall <= 0) return []

  const expiresAt = new Date(now().getTime() + INVITE_TTL_DAYS * MS_PER_DAY)
  const rows: Array<{ code: string; createdBy: string; expiresAt: Date }> = []

  while (rows.length < shortfall) {
    const code = generateCode()
    if (taken.has(code)) continue // Vanishingly rare, but a unique index would reject it.
    taken.add(code)
    rows.push({ code, createdBy: input.userId, expiresAt })
  }

  return repository.insertInvites(rows)
}
```

- [ ] **Step 9: Fix the misused error code**

The blank-name check in `redeem-invite.ts` throws `invalid_amount`, which is about money. Add a proper code.

In `lib/domain/errors.ts`, add to the `// shared` group:

```ts
  | 'invalid_input'
```

In `lib/domain/membership/redeem-invite.ts`, change the blank-name throw to:

```ts
    throw new DomainError('invalid_input', 'Enter your name so hosts know who is asking for a seat.')
```

- [ ] **Step 10: Run the whole suite**

```bash
npm test && npm run lint
```

Expected: every test passes and lint is clean. The blank-name test asserts only `toBeInstanceOf(DomainError)`, so the code change does not break it.

- [ ] **Step 11: Commit**

```bash
git add lib/domain/membership tests/domain/membership tests/support lib/domain/errors.ts
git commit -m "feat: add invite redemption and issuance use cases"
```

---

### Task 6: PostgreSQL membership repository

Implements the port against real PostgreSQL and proves the claim race is genuinely atomic — with two concurrent transactions, not a mock.

**Files:**
- Create: `lib/db/repositories/membership.ts`
- Create: `tests/support/db-setup.ts`, `tests/support/db-helpers.ts`
- Test: `tests/integration/membership-repository.test.ts`

**Interfaces:**
- Consumes: `MembershipRepository`, `NewUser` (Task 5); `db`, schema (Task 3).
- Produces: `class PostgresMembershipRepository implements MembershipRepository`, constructed as `new PostgresMembershipRepository(db)`.

- [ ] **Step 1: Create the test database and setup helpers**

```bash
docker compose exec -T db psql -U party -d party -c "CREATE DATABASE party_test"
DATABASE_URL=postgres://party:party@localhost:5435/party_test npm run db:migrate
```

Create `tests/support/db-setup.ts`:

```ts
import 'dotenv/config'

// Every integration test must run against the test database. Pointing them at
// the dev database would truncate real local data on the first run.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.')
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
```

Create `tests/support/db-helpers.ts`:

```ts
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'

export async function truncateAll(): Promise<void> {
  await db.execute(sql`
    truncate table
      email_log, seat_payments, seat_requests, table_listings,
      venues, invites, sessions, accounts, verification_tokens, users
    restart identity cascade
  `)
}

export async function seedUser(overrides: Partial<{ email: string; name: string }> = {}) {
  const [user] = await db.insert(users).values({
    email: overrides.email ?? `user-${crypto.randomUUID()}@example.com`,
    name: overrides.name ?? 'Test User',
  }).returning()
  return user
}
```

- [ ] **Step 2: Write the failing integration tests**

Create `tests/integration/membership-repository.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { invites, users } from '@/lib/db/schema'
import { PostgresMembershipRepository } from '@/lib/db/repositories/membership'
import { seedUser, truncateAll } from '../support/db-helpers'

const repository = new PostgresMembershipRepository(db)

let hostId: string

beforeEach(async () => {
  await truncateAll()
  hostId = (await seedUser({ email: 'host@example.com', name: 'Host' })).id
})

async function seedInvite(code: string, expiresAt = new Date('2099-01-01T00:00:00Z')) {
  const [invite] = await db.insert(invites).values({ code, createdBy: hostId, expiresAt }).returning()
  return invite
}

describe('PostgresMembershipRepository', () => {
  it('round-trips an invite by code', async () => {
    await seedInvite('ABCD-EFGH')

    const found = await repository.findInviteByCode('ABCD-EFGH')

    expect(found).toMatchObject({ code: 'ABCD-EFGH', createdBy: hostId, redeemedBy: null })
    expect(found!.expiresAt).toBeInstanceOf(Date)
  })

  it('returns null for a code that does not exist', async () => {
    expect(await repository.findInviteByCode('ZZZZ-ZZZZ')).toBeNull()
  })

  it('finds a user by email case-insensitively', async () => {
    await seedUser({ email: 'someone@example.com', name: 'Someone' })

    expect(await repository.findUserByEmail('SomeOne@Example.com')).not.toBeNull()
  })

  it('creates the user and stamps the invite in one atomic step', async () => {
    const invite = await seedInvite('ABCD-EFGH')

    const user = await repository.claimInviteAndCreateUser(invite.id, {
      email: 'new@example.com', name: 'New Member', instagramHandle: '@new', invitedBy: hostId,
    })

    expect(user).not.toBeNull()
    expect(user!.invitedBy).toBe(hostId)
    expect(user!.status).toBe('active')

    const [stored] = await db.select().from(invites).where(eq(invites.id, invite.id))
    expect(stored.redeemedBy).toBe(user!.id)
    expect(stored.redeemedAt).toBeInstanceOf(Date)
  })

  it('returns null when the invite was already claimed', async () => {
    const invite = await seedInvite('ABCD-EFGH')
    await repository.claimInviteAndCreateUser(invite.id, {
      email: 'first@example.com', name: 'First', instagramHandle: null, invitedBy: hostId,
    })

    const second = await repository.claimInviteAndCreateUser(invite.id, {
      email: 'second@example.com', name: 'Second', instagramHandle: null, invitedBy: hostId,
    })

    expect(second).toBeNull()
  })

  it('creates no orphan user when the claim loses', async () => {
    const invite = await seedInvite('ABCD-EFGH')
    await repository.claimInviteAndCreateUser(invite.id, {
      email: 'first@example.com', name: 'First', instagramHandle: null, invitedBy: hostId,
    })

    await repository.claimInviteAndCreateUser(invite.id, {
      email: 'second@example.com', name: 'Second', instagramHandle: null, invitedBy: hostId,
    })

    const orphans = await db.select().from(users).where(eq(users.email, 'second@example.com'))
    expect(orphans).toHaveLength(0)
  })

  it('lets exactly one of two simultaneous redemptions win', async () => {
    const invite = await seedInvite('ABCD-EFGH')

    const results = await Promise.all([
      repository.claimInviteAndCreateUser(invite.id, {
        email: 'racer-a@example.com', name: 'Racer A', instagramHandle: null, invitedBy: hostId,
      }),
      repository.claimInviteAndCreateUser(invite.id, {
        email: 'racer-b@example.com', name: 'Racer B', instagramHandle: null, invitedBy: hostId,
      }),
    ])

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)

    const allUsers = await db.select().from(users)
    expect(allUsers.filter((u) => u.email.startsWith('racer-'))).toHaveLength(1)
  })

  it('inserts a batch of invites and returns them', async () => {
    const expiresAt = new Date('2099-01-01T00:00:00Z')

    const created = await repository.insertInvites([
      { code: 'AAAA-AAAA', createdBy: hostId, expiresAt },
      { code: 'BBBB-BBBB', createdBy: hostId, expiresAt },
    ])

    expect(created.map((i) => i.code).sort()).toEqual(['AAAA-AAAA', 'BBBB-BBBB'])
    expect(await repository.listInvitesCreatedBy(hostId)).toHaveLength(2)
  })
})
```

The two-simultaneous-redemptions test is the reason this task exists. Its assertion that only one `racer-` user exists is what proves the operation is genuinely atomic rather than merely appearing so under sequential calls.

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
npm run test:integration
```

Expected: failure resolving `@/lib/db/repositories/membership`.

- [ ] **Step 4: Implement the repository**

Create `lib/db/repositories/membership.ts`:

```ts
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { invites, users } from '../schema'
import type { MembershipRepository, NewUser } from '@/lib/domain/membership/ports'
import type { Invite, User } from '@/lib/domain/membership/types'

type UserRow = typeof users.$inferSelect
type InviteRow = typeof invites.$inferSelect

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    instagramHandle: row.instagramHandle,
    status: row.status,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
  }
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    code: row.code,
    createdBy: row.createdBy,
    redeemedBy: row.redeemedBy,
    redeemedAt: row.redeemedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Db) {}

  async findUserByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users)
      .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
      .limit(1)
    return row ? toUser(row) : null
  }

  async findInviteByCode(code: string): Promise<Invite | null> {
    const [row] = await this.db.select().from(invites).where(eq(invites.code, code)).limit(1)
    return row ? toInvite(row) : null
  }

  async listInvitesCreatedBy(userId: string): Promise<Invite[]> {
    const rows = await this.db.select().from(invites).where(eq(invites.createdBy, userId))
    return rows.map(toInvite)
  }

  async claimInviteAndCreateUser(inviteId: string, newUser: NewUser): Promise<User | null> {
    return this.db.transaction(async (tx) => {
      // Claim first, using redeemedAt. The `isNull(redeemedAt)` predicate makes
      // this a compare-and-set: a concurrent transaction that already claimed
      // the row leaves this UPDATE matching zero rows, so the loser creates no
      // user. redeemedBy cannot be used for the claim because it has a foreign
      // key to users.id and the winning user does not exist yet — it is filled
      // in below, inside the same transaction, so no one observes the gap.
      const claimed = await tx.update(invites)
        .set({ redeemedAt: new Date() })
        .where(and(eq(invites.id, inviteId), isNull(invites.redeemedAt)))
        .returning({ id: invites.id })

      if (claimed.length === 0) return null

      const [created] = await tx.insert(users).values({
        email: newUser.email,
        name: newUser.name,
        instagramHandle: newUser.instagramHandle,
        invitedBy: newUser.invitedBy,
      }).returning()

      await tx.update(invites).set({ redeemedBy: created.id }).where(eq(invites.id, inviteId))

      return toUser(created)
    })
  }

  async insertInvites(rows: Array<{ code: string; createdBy: string; expiresAt: Date }>): Promise<Invite[]> {
    if (rows.length === 0) return []
    const created = await this.db.insert(invites).values(rows).returning()
    return created.map(toInvite)
  }
}
```

The two-step claim deserves explanation, because the obvious single-step version cannot work. `redeemedBy` carries a foreign key to `users.id`, so it cannot be set before the user row exists — but the user must not be created before the claim is won, or the losing transaction leaves an orphan account behind. The ordering is therefore forced: claim on `redeemedAt`, which has no foreign key, then create the user, then backfill `redeemedBy`. All three happen inside one transaction, so no other session ever observes an invite that is claimed but unattributed.

This is why `redeemedAt` rather than `redeemedBy` is the authoritative "is this invite spent" predicate everywhere in the codebase.

- [ ] **Step 5: Run the integration tests**

```bash
npm run test:integration
```

Expected: all tests pass, including the concurrent-redemption test.

- [ ] **Step 6: Prove the race test can actually fail**

A concurrency test that would pass against broken code is worthless. Temporarily replace the body of `claimInviteAndCreateUser` with a naive check-then-act:

```ts
    const [invite] = await this.db.select().from(invites).where(eq(invites.id, inviteId)).limit(1)
    if (!invite || invite.redeemedAt !== null) return null
    const [created] = await this.db.insert(users).values({
      email: newUser.email, name: newUser.name,
      instagramHandle: newUser.instagramHandle, invitedBy: newUser.invitedBy,
    }).returning()
    await this.db.update(invites).set({ redeemedBy: created.id, redeemedAt: new Date() }).where(eq(invites.id, inviteId))
    return toUser(created)
```

```bash
npm run test:integration
```

Expected: "lets exactly one of two simultaneous redemptions win" FAILS with 2 winners. **Restore the correct implementation** and re-run to confirm it passes again.

- [ ] **Step 7: Commit**

```bash
git add lib/db/repositories tests/integration tests/support
git commit -m "feat: add Postgres membership repository with atomic invite claim"
```

---

### Task 7: Magic-link authentication

Auth.js signs people in but must never create them — account creation belongs to `redeemInvite`, which is where the invite invariant lives.

**Files:**
- Create: `lib/auth.ts`, `app/api/auth/[...nextauth]/route.ts`
- Create: `app/login/page.tsx`, `types/next-auth.d.ts`

**Interfaces:**
- Consumes: `db` and schema (Task 3).
- Produces: `auth()`, `signIn()`, `signOut()`, `handlers` exported from `@/lib/auth`; `auth()` returns a session whose `user.id` is the `users.id` uuid.

- [ ] **Step 1: Configure Auth.js**

Create `lib/auth.ts`:

```ts
import NextAuth from 'next-auth'
import Resend from 'next-auth/providers/resend'
import { DrizzleAdapter } from '@auth/drizzle-adapter'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema'

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'database' },
  pages: { signIn: '/login', verifyRequest: '/login?sent=1', error: '/login' },
  providers: [
    // Deliberately the only provider, and deliberately isolated on one line.
    //
    // EMAIL_FROM is Resend's shared test sender (onboarding@resend.dev), which
    // delivers ONLY to the address registered on the Resend account. Real
    // members therefore cannot receive a sign-in link yet. See the dev escape
    // hatch below, and README "Known limitation: email".
    //
    // The fix is to replace this single line — either with a verified sending
    // domain, or with Nodemailer against any SMTP mailbox:
    //   Nodemailer({ server: process.env.EMAIL_SERVER!, from: process.env.EMAIL_FROM! })
    // Nothing else in the application changes.
    Resend({ from: process.env.EMAIL_FROM!, apiKey: process.env.RESEND_API_KEY! }),
  ],
  callbacks: {
    /**
     * The membership gate. Auth.js would otherwise create an account for any
     * email that requests a magic link, which would bypass invite codes
     * entirely. Accounts are created only by redeemInvite; this callback lets
     * in existing, active members and nobody else.
     */
    async signIn({ user }) {
      const email = user.email?.trim().toLowerCase()
      if (!email) return false

      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
      if (!existing) return false
      if (existing.status !== 'active') return false

      return true
    },
    async session({ session, user }) {
      session.user.id = user.id
      return session
    },
  },
})
```

- [ ] **Step 2: Add the route handler**

Create `app/api/auth/[...nextauth]/route.ts`:

```ts
export { GET, POST } from '@/lib/auth'
```

**Do not add a `middleware.ts` that calls `auth()`.** Next.js middleware runs in the Edge runtime, and this `auth()` is bound to a Drizzle adapter backed by `postgres.js`, which opens TCP sockets and cannot run there. Importing it from middleware produces a confusing runtime failure rather than a clean build error.

Route protection is instead done per page, in the Node runtime, with the same three lines each protected page already uses:

```ts
const session = await auth()
if (!session?.user?.id) redirect('/login')
```

Auth.js's own documentation offers a split-config workaround (a JWT-only `auth.config.ts` for middleware plus a full config for the server). That is worth adopting only if the page count grows enough that repeating the guard becomes error-prone. With four routes it is not.

- [ ] **Step 3: Build the login page**

Create `app/login/page.tsx`:

```tsx
import { signIn } from '@/lib/auth'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>
}) {
  const { sent } = await searchParams

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-neutral-500">
          We&apos;ll email you a link. No password to remember.
        </p>
      </div>

      {sent ? (
        <p className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          Check your email for the sign-in link.
        </p>
      ) : (
        <form
          className="flex flex-col gap-3"
          action={async (formData) => {
            'use server'
            await signIn('resend', {
              email: String(formData.get('email')),
              redirectTo: '/',
            })
          }}
        >
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className="rounded-lg border border-neutral-300 px-4 py-3 text-base dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button type="submit" className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white dark:bg-white dark:text-neutral-900">
            Email me a link
          </button>
        </form>
      )}

      <p className="text-sm text-neutral-500">
        Got an invite code? <a href="/join" className="underline">Redeem it here</a>.
      </p>
    </main>
  )
}
```

`text-base` on the input is deliberate: iOS Safari zooms the viewport when a focused input has a font size below 16px, which on a phone at 1am is genuinely disorienting.

- [ ] **Step 4: Add the session type declaration**

Create `types/next-auth.d.ts`:

```ts
import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user']
  }
}
```

- [ ] **Step 5: Verify the gate manually**

```bash
npm run dev
```

Seed one member directly so there is an account to sign in as:

```bash
docker compose exec -T db psql -U party -d party -c \
  "insert into users (email, name) values ('you@example.com', 'You') on conflict do nothing"
```

Use the email registered on your Resend account for `you@example.com` above. With the shared test sender, Resend delivers to that address and no other.

Then, with `RESEND_API_KEY` set in `.env.local`:

1. Visit `http://localhost:3000/login`.
2. Submit the seeded address → expect the "check your email" state, and an email to arrive.
3. Click the link → expect to land on `/` signed in.
4. Submit `stranger@example.com` → **expect no email, and no new row in `verification_tokens`**:

```bash
docker compose exec -T db psql -U party -d party -c \
  "select identifier, expires from verification_tokens order by expires desc limit 5"
```

Step 4 is the membership gate, and it is the single most important behaviour in this task. If a stranger gets a link, or a `users` row appears for them, the `signIn` callback is not doing its job — stop and fix it before continuing.

**Dev escape hatch.** To sign in as any *seeded* member without receiving mail — which you will need constantly, since the test sender reaches only one inbox — read the token straight from the database and build the callback URL:

```bash
docker compose exec -T db psql -U party -d party -t -A -F' ' -c \
  "select identifier, token from verification_tokens order by expires desc limit 1"
```

Then visit `http://localhost:3000/api/auth/callback/resend?token=<token>&email=<identifier>`.

This works because the gate is enforced at *request* time, not at delivery time: a token only exists for an address that already passed the `signIn` callback. Reading it out of the database bypasses your inbox, not the membership check.

- [ ] **Step 6: Commit**

```bash
git add lib/auth.ts app/api app/login types
git commit -m "feat: add magic-link auth gated to existing active members"
```

---

### Task 8: The join page

**Files:**
- Create: `app/join/page.tsx`, `app/join/actions.ts`
- Create: `lib/membership-service.ts`
- Test: `tests/integration/redeem-invite-flow.test.ts`

**Interfaces:**
- Consumes: `redeemInvite`, `issueInvites` (Task 5); `PostgresMembershipRepository` (Task 6); `signIn` (Task 7).
- Produces: `membershipDeps` from `@/lib/membership-service`, the single wired-up `MembershipDeps` every adapter uses.

- [ ] **Step 1: Wire the domain to the database**

Create `lib/membership-service.ts`:

```ts
import { db } from '@/lib/db/client'
import { PostgresMembershipRepository } from '@/lib/db/repositories/membership'
import type { MembershipDeps } from '@/lib/domain/membership/ports'

export const membershipDeps: MembershipDeps = {
  repository: new PostgresMembershipRepository(db),
  now: () => new Date(),
}
```

This file is the only place the domain layer meets the database. Everything above it depends on interfaces.

- [ ] **Step 2: Write the failing end-to-end domain test**

Create `tests/integration/redeem-invite-flow.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db/client'
import { PostgresMembershipRepository } from '@/lib/db/repositories/membership'
import { issueInvites } from '@/lib/domain/membership/issue-invites'
import { redeemInvite } from '@/lib/domain/membership/redeem-invite'
import { seedUser, truncateAll } from '../support/db-helpers'

const deps = { repository: new PostgresMembershipRepository(db), now: () => new Date() }

beforeEach(truncateAll)

describe('issue then redeem, against real Postgres', () => {
  it('lets a member invite someone who becomes a member with their own codes', async () => {
    const host = await seedUser({ email: 'host@example.com', name: 'Host' })

    const [firstCode] = await issueInvites(deps, { userId: host.id })

    const joiner = await redeemInvite(deps, {
      code: firstCode.code,
      email: 'joiner@example.com',
      name: 'Joiner',
      instagramHandle: '@joiner',
    })

    expect(joiner.invitedBy).toBe(host.id)

    const joinerInvites = await issueInvites(deps, { userId: joiner.id })
    expect(joinerInvites).toHaveLength(3)
  })

  it('refuses to reuse a code that has been redeemed', async () => {
    const host = await seedUser({ email: 'host@example.com', name: 'Host' })
    const [code] = await issueInvites(deps, { userId: host.id })

    await redeemInvite(deps, { code: code.code, email: 'first@example.com', name: 'First', instagramHandle: null })

    await expect(redeemInvite(deps, {
      code: code.code, email: 'second@example.com', name: 'Second', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'invite_already_redeemed' })
  })

  it('leaves the host holding two live codes after one is spent', async () => {
    const host = await seedUser({ email: 'host@example.com', name: 'Host' })
    const [code] = await issueInvites(deps, { userId: host.id })

    await redeemInvite(deps, { code: code.code, email: 'joiner@example.com', name: 'Joiner', instagramHandle: null })

    const topUp = await issueInvites(deps, { userId: host.id })
    expect(topUp).toHaveLength(0) // spent codes are not replenished

    const live = (await deps.repository.listInvitesCreatedBy(host.id)).filter((i) => i.redeemedAt === null)
    expect(live).toHaveLength(2)
  })
})
```

- [ ] **Step 3: Run and confirm it fails, then passes**

```bash
npm run test:integration
```

If it fails only on missing imports, create the files below first. Once `lib/membership-service.ts` exists, this suite should pass without new production code — it exercises Tasks 5 and 6 together.

- [ ] **Step 4: Write the server action**

Create `app/join/actions.ts`:

```ts
'use server'

import { signIn } from '@/lib/auth'
import { isDomainError } from '@/lib/domain/errors'
import { issueInvites } from '@/lib/domain/membership/issue-invites'
import { redeemInvite } from '@/lib/domain/membership/redeem-invite'
import { membershipDeps } from '@/lib/membership-service'

export interface JoinFormState {
  error?: string
}

export async function joinAction(_prev: JoinFormState, formData: FormData): Promise<JoinFormState> {
  const email = String(formData.get('email') ?? '')

  try {
    const user = await redeemInvite(membershipDeps, {
      code: String(formData.get('code') ?? ''),
      email,
      name: String(formData.get('name') ?? ''),
      instagramHandle: String(formData.get('instagramHandle') ?? '') || null,
    })

    await issueInvites(membershipDeps, { userId: user.id })
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  // Outside the try: signIn redirects by throwing, and catching that would
  // turn a successful sign-in into a rendered error.
  await signIn('resend', { email: email.trim().toLowerCase(), redirectTo: '/' })
  return {}
}
```

The comment on the last lines is not incidental. Next.js server actions signal redirects by throwing a special error; wrapping `signIn` in the `try` block would swallow it and show the user a failure after their account was successfully created.

- [ ] **Step 5: Build the join page**

Create `app/join/page.tsx`. Note the `Suspense` wrapper: `useSearchParams` opts the subtree into client-side rendering, and Next.js 15 **fails the production build** with "useSearchParams() should be wrapped in a suspense boundary" if there isn't one. It builds fine in dev, so this only surfaces at `npm run build`.

```tsx
'use client'

import { Suspense, useActionState } from 'react'
import { useSearchParams } from 'next/navigation'
import { joinAction, type JoinFormState } from './actions'

const inputClass =
  'rounded-lg border border-neutral-300 px-4 py-3 text-base dark:border-neutral-700 dark:bg-neutral-950'

export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinForm />
    </Suspense>
  )
}

function JoinForm() {
  const params = useSearchParams()
  const [state, formAction, pending] = useActionState<JoinFormState, FormData>(joinAction, {})

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">You&apos;re invited</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Enter your invite code and a few details. We&apos;ll email you a sign-in link.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        <input
          name="code" required placeholder="ABCD-EFGH" autoCapitalize="characters"
          defaultValue={params.get('code') ?? ''} className={`${inputClass} font-mono tracking-widest`}
        />
        <input name="name" required placeholder="Your name" autoComplete="name" className={inputClass} />
        <input name="email" type="email" required placeholder="you@example.com" autoComplete="email" className={inputClass} />
        <input name="instagramHandle" placeholder="@instagram (optional)" autoCapitalize="none" className={inputClass} />

        {state.error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {state.error}
          </p>
        )}

        <button
          type="submit" disabled={pending}
          className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? 'Joining…' : 'Join'}
        </button>
      </form>

      <p className="text-sm text-neutral-500">
        Already a member? <a href="/login" className="underline">Sign in</a>.
      </p>
    </main>
  )
}
```

Prefilling the code from `?code=` is what makes a shared link work in one tap, which is how codes will actually travel.

- [ ] **Step 6: Verify manually**

```bash
npm run dev
```

1. Issue a code for your seeded user by visiting `/invites` after Task 9, or insert one directly with psql.
2. Visit `/join?code=<the code>` → expect the field prefilled.
3. Submit with a fresh email → expect a sign-in email and a new row in `users` with `invited_by` set.
4. Submit the same code again → expect "That invite has already been used."
5. Submit a nonsense code → expect "That invite code doesn't look right."

- [ ] **Step 7: Confirm the production build still passes**

```bash
npm run build
```

Expected: success. This catches the `useSearchParams` Suspense requirement, which dev mode does not enforce.

- [ ] **Step 8: Commit**

```bash
git add app/join lib/membership-service.ts tests/integration/redeem-invite-flow.test.ts
git commit -m "feat: add invite redemption page and server action"
```

---

### Task 9: The invites page

**Files:**
- Create: `app/invites/page.tsx`, `app/invites/copy-button.tsx`

**Interfaces:**
- Consumes: `auth()` (Task 7), `issueInvites`/`listInvitesCreatedBy` (Tasks 5, 6), `membershipDeps` (Task 8).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Build the copy-to-clipboard control**

Create `app/invites/copy-button.tsx`:

```tsx
'use client'

import { useState } from 'react'

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700"
    >
      {copied ? 'Copied' : label}
    </button>
  )
}
```

- [ ] **Step 2: Build the page**

Create `app/invites/page.tsx`:

```tsx
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { INVITE_QUOTA, issueInvites } from '@/lib/domain/membership/issue-invites'
import { membershipDeps } from '@/lib/membership-service'
import { CopyButton } from './copy-button'

export default async function InvitesPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  // Idempotent: tops the member up to their quota, or does nothing.
  await issueInvites(membershipDeps, { userId: session.user.id })

  const all = await membershipDeps.repository.listInvitesCreatedBy(session.user.id)
  const now = new Date()
  const live = all.filter((i) => i.redeemedAt === null && i.expiresAt > now)
  const spent = all.filter((i) => i.redeemedAt !== null)

  const host = (await headers()).get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') ? 'http' : 'https'
  const linkFor = (code: string) => `${protocol}://${host}/join?code=${code}`

  return (
    <main className="mx-auto max-w-sm px-6 py-10">
      <h1 className="text-2xl font-semibold">Your invites</h1>
      <p className="mt-2 text-sm text-neutral-500">
        You get {INVITE_QUOTA} codes. Each works once. Used codes aren&apos;t replaced —
        choose carefully.
      </p>

      <ul className="mt-6 flex flex-col gap-3">
        {live.map((invite) => (
          <li key={invite.id} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <div>
              <p className="font-mono text-lg tracking-widest">{invite.code}</p>
              <p className="text-xs text-neutral-500">
                Expires {invite.expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </p>
            </div>
            <CopyButton value={linkFor(invite.code)} label="Copy link" />
          </li>
        ))}
      </ul>

      {live.length === 0 && (
        <p className="mt-6 rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          You&apos;ve used all your invites.
        </p>
      )}

      {spent.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-500">Used</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {spent.map((invite) => (
              <li key={invite.id} className="font-mono text-sm text-neutral-400 line-through">
                {invite.code}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
```

- [ ] **Step 3: Verify manually**

Visit `/invites` while signed in. Expect three codes on first load, the same three on refresh (proving idempotency — if the count grows, `issueInvites` is broken), and a working "Copy link" that pastes a `/join?code=…` URL.

- [ ] **Step 4: Commit**

```bash
git add app/invites
git commit -m "feat: add invites page with shareable join links"
```

---

### Task 10: Seed the founding member and venues

Invite codes require an inviter, so the first member cannot be created by the normal flow. This is the bootstrap.

**Files:**
- Create: `scripts/seed.ts`
- Modify: `package.json` (add `db:seed`)

**Interfaces:**
- Consumes: `db`, schema (Task 3); `issueInvites` (Task 5); `membershipDeps` (Task 8).
- Produces: an `npm run db:seed` command, safe to run repeatedly.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed.ts`:

```ts
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { users, venues } from '@/lib/db/schema'
import { issueInvites } from '@/lib/domain/membership/issue-invites'
import { membershipDeps } from '@/lib/membership-service'

const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL
const FOUNDER_NAME = process.env.FOUNDER_NAME ?? 'Founder'

const VENUES = [
  { name: 'Savaya', city: 'Bali' },
  { name: 'Miss Fish', city: 'Bali' },
]

async function main() {
  if (!FOUNDER_EMAIL) throw new Error('FOUNDER_EMAIL is not set')

  // Idempotent: safe to run on every deploy.
  for (const venue of VENUES) {
    const [existing] = await db.select().from(venues).where(eq(venues.name, venue.name)).limit(1)
    if (!existing) {
      await db.insert(venues).values(venue)
      console.log(`seeded venue: ${venue.name}`)
    }
  }

  const email = FOUNDER_EMAIL.trim().toLowerCase()
  let [founder] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  if (!founder) {
    // invitedBy stays null — the founding member is the one account with no inviter.
    ;[founder] = await db.insert(users).values({ email, name: FOUNDER_NAME }).returning()
    console.log(`seeded founder: ${email}`)
  }

  const issued = await issueInvites(membershipDeps, { userId: founder.id })
  console.log(`founder holds their quota; issued ${issued.length} new code(s)`)
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
```

- [ ] **Step 2: Add the script and its runner**

```bash
npm install -D tsx
```

Add to `package.json` scripts:

```json
"db:seed": "tsx --tsconfig tsconfig.json scripts/seed.ts"
```

Add to `.env.example`:

```
FOUNDER_EMAIL=
FOUNDER_NAME=
```

- [ ] **Step 3: Run it, twice**

```bash
FOUNDER_EMAIL=you@example.com FOUNDER_NAME="Your Name" npm run db:seed
FOUNDER_EMAIL=you@example.com FOUNDER_NAME="Your Name" npm run db:seed
```

Expected: the first run seeds two venues, the founder, and three codes. The second run seeds nothing and issues zero codes. If the second run creates duplicates, the idempotency is broken — fix it before continuing, because this script will run on every deploy.

- [ ] **Step 4: Commit**

```bash
git add scripts package.json package-lock.json .env.example
git commit -m "feat: add idempotent seed for founding member and venues"
```

---

### Task 11: Deploy to a DigitalOcean Droplet

A single Droplet running Docker Compose: Postgres, the app, and Caddy terminating TLS. No managed database and no domain — Caddy gets a real certificate for an `sslip.io` hostname derived from the Droplet's IP.

> **Amended after this plan was written.** The project has a domain: **`wazup.party`**, with DNS on Cloudflare. The `sslip.io` hostname below, and the "known limitation: email" that follows from Resend's shared test sender, are both **obsolete**.
>
> Execute this task as written anyway — it stands up the Droplet, the Compose stack, the firewall, and the nightly `pg_dump`, none of which change. Then either substitute `wazup.party` for the `sslip.io` hostname as you go, or ship on `sslip.io` first and cut over later; both work, because the only difference is the name in the `Caddyfile` and in `AUTH_URL`.
>
> **The authoritative cutover is Plan 3 Task 12** (`docs/superpowers/plans/2026-07-25-settlement-and-notifications.md`), which covers the Cloudflare records and the DNS-only requirement, the `www` redirect, verifying `wazup.party` as a Resend sending domain, and retiring the email limitation from the README and the spec. Read it before writing the `Caddyfile` if you intend to go straight to the real domain.
>
> One thing to carry over now regardless: set `AUTH_TRUST_HOST=true`. Auth.js behind Caddy rejects every callback without it, whichever hostname you serve.

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.prod.yml`, `Caddyfile`
- Create: `app/page.tsx` (replace the scaffold placeholder)
- Modify: `next.config.ts`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a running deployment. Plan 2 replaces `app/page.tsx` with the real feed.

- [ ] **Step 1: Replace the placeholder home page**

Create `app/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'

export default async function HomePage() {
  const session = await auth()
  if (!session?.user) redirect('/login')

  return (
    <main className="mx-auto max-w-sm px-6 py-10">
      <h1 className="text-2xl font-semibold">Tables</h1>
      <p className="mt-2 text-sm text-neutral-500">
        No tables yet. Listings arrive in the next release.
      </p>
      <a href="/invites" className="mt-6 inline-block text-sm underline">
        Your invites
      </a>
    </main>
  )
}
```

- [ ] **Step 2: Enable standalone output**

Modify `next.config.ts`:

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Emits .next/standalone with only the files the server actually needs,
  // which keeps the production image around 150MB instead of 1GB.
  output: 'standalone',
}

export default nextConfig
```

- [ ] **Step 3: Write the Dockerfile**

Create `Dockerfile`:

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# lib/db/client.ts throws at import time when DATABASE_URL is unset, and the
# build imports it transitively through lib/auth.ts. postgres.js does not open
# a connection on construction, so a syntactically valid dummy is enough — no
# database is reachable or needed during the build.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

Create `.dockerignore`:

```
node_modules
.next
.git
.env*
docs
tests
drizzle/meta
```

The `builder` stage is kept as a named target rather than discarded, because migrations need `drizzle-kit` and `tsx` — both devDependencies absent from the slim runner image.

- [ ] **Step 4: Write the production compose file**

Create `docker-compose.prod.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: party
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: party
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U party"]
      interval: 5s
      timeout: 5s
      retries: 20
    # Deliberately no `ports:` — Postgres is reachable only from the compose
    # network. A Droplet with an exposed 5432 is found by scanners within hours.

  migrate:
    build:
      context: .
      target: builder
    env_file: .env.production
    depends_on:
      db:
        condition: service_healthy
    command: sh -c "npm run db:migrate && npm run db:seed"
    restart: "no"

  web:
    build:
      context: .
      target: runner
    env_file: .env.production
    depends_on:
      db:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped
    expose:
      - "3000"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - web

volumes:
  pgdata:
  caddy_data:
  caddy_config:
```

`migrate` runs to completion before `web` starts, so the schema is never behind the code.

- [ ] **Step 5: Write the Caddyfile**

Create `Caddyfile`:

```
{$SITE_ADDRESS} {
	reverse_proxy web:3000
}
```

Two lines, and they solve the no-domain problem entirely.

`SITE_ADDRESS` will be a `sslip.io` hostname: `sslip.io` is a public wildcard DNS service that resolves any host of the form `143-198-1-2.sslip.io` to the IP embedded in it. That gives the Droplet a real, publicly-resolvable name at no cost, which is all Let's Encrypt requires — so Caddy provisions and renews a genuine certificate automatically.

This matters more than it looks. Auth.js session cookies carry a live session token; over plain HTTP they travel in clear text on whatever café or club wifi the user is on. A certificate is not optional here just because there is no domain.

- [ ] **Step 6: Create the Droplet**

In the DigitalOcean control panel, or with `doctl`:

```bash
doctl compute droplet create party \
  --region sgp1 \
  --image ubuntu-24-04-x64 \
  --size s-1vcpu-2gb \
  --ssh-keys "$(doctl compute ssh-key list --format ID --no-header | head -1)" \
  --wait
```

`sgp1` is Singapore, the closest region to Bali.

**Do not choose the 1GB size.** `next build` routinely exceeds 1GB of resident memory and the OOM killer terminates it with a message that looks nothing like an out-of-memory error. 2GB costs a few dollars more per month and removes an afternoon of confusion.

Note the IP address:

```bash
doctl compute droplet get party --format PublicIPv4 --no-header
```

- [ ] **Step 7: Provision the Droplet**

SSH in as root and run:

```bash
# Docker with the compose plugin
curl -fsSL https://get.docker.com | sh

# 2GB of swap: cheap insurance for the build step and for Postgres under load
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Only SSH and HTTP(S) reach the internet
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Unattended security updates
apt-get update && apt-get install -y unattended-upgrades
```

Verify:

```bash
docker compose version   # expect v2.x
free -h                  # expect 2.0Gi swap
ufw status               # expect 22, 80, 443 only
```

- [ ] **Step 8: Configure and deploy**

On the Droplet:

```bash
git clone https://github.com/YOUR_ORG/party.git /opt/party
cd /opt/party
```

Create `/opt/party/.env.production`. Substitute the Droplet's IP with dashes in `SITE_ADDRESS` and `AUTH_URL` — an IP of `143.198.1.2` becomes `143-198-1-2.sslip.io`:

```
POSTGRES_PASSWORD=<generate with: openssl rand -base64 24>
DATABASE_URL=postgres://party:<same password>@db:5432/party

SITE_ADDRESS=143-198-1-2.sslip.io
AUTH_URL=https://143-198-1-2.sslip.io
AUTH_SECRET=<generate with: openssl rand -base64 32>
# Caddy terminates TLS and proxies over HTTP, so Auth.js must be told to trust
# the forwarded host rather than inferring http:// and building broken links.
AUTH_TRUST_HOST=true

RESEND_API_KEY=<your key>
EMAIL_FROM="Party <onboarding@resend.dev>"

CRON_SECRET=<generate with: openssl rand -base64 32>
FOUNDER_EMAIL=<the email on your Resend account>
FOUNDER_NAME=<your name>
```

`FOUNDER_EMAIL` must be the address registered to your Resend account. With the shared test sender, that is the only address Resend will deliver to — see Task 7.

Set the compose file as the default so later commands are shorter, then bring it up:

```bash
echo 'COMPOSE_FILE=docker-compose.prod.yml' >> /opt/party/.env
docker compose up -d --build
docker compose logs -f migrate
```

Expected: the migrate container applies migrations, seeds venues and the founder, and exits 0. Then `docker compose ps` shows `db`, `web`, and `caddy` running and `migrate` exited.

- [ ] **Step 9: Verify against reality**

From your laptop, against `https://<dashed-ip>.sslip.io`:

1. The certificate is valid — no browser warning. If Caddy could not issue, check `docker compose logs caddy`; the usual cause is port 80 being blocked, which Let's Encrypt needs for the HTTP challenge.
2. `/` redirects to `/login`.
3. Sign in as `FOUNDER_EMAIL` → the email arrives and the link signs you in.
4. `/invites` shows three codes.
5. Open a code's join link in a private window and redeem it with a **second** email you control. The account is created, but **no email will arrive** — Resend's test sender only delivers to your own account address. Recover the sign-in link from the logs:

```bash
docker compose exec db psql -U party -d party \
  -c "select identifier, token, expires from verification_tokens order by expires desc limit 1"
```

Then visit `https://<dashed-ip>.sslip.io/api/auth/callback/resend?token=<token>&email=<identifier>`.

6. Request a link for an email with no account → no email, and no user row created. This is the invite gate, and it is the one behaviour that must hold in production.

Step 5 is tedious on purpose: it is the cost of the test sender, and it is exactly what a verified domain or an SMTP mailbox removes. Nothing else in the system needs to change to fix it — see Task 7.

- [ ] **Step 10: Set up backups**

The Droplet holds the only copy of the database. Add a nightly dump:

```bash
mkdir -p /opt/party/backups
cat > /etc/cron.daily/party-backup <<'SCRIPT'
#!/bin/sh
cd /opt/party || exit 1
FILE="/opt/party/backups/party-$(date +%F).sql.gz"
docker compose exec -T db pg_dump -U party party | gzip > "$FILE"
find /opt/party/backups -name 'party-*.sql.gz' -mtime +14 -delete
SCRIPT
chmod +x /etc/cron.daily/party-backup
```

Run it once by hand and confirm the file is non-empty:

```bash
/etc/cron.daily/party-backup && ls -lh /opt/party/backups
```

A backup that has never been produced is not a backup. Also enable weekly Droplet snapshots in the DigitalOcean panel — the dumps live on the same disk they protect against losing.

Redeploying later is:

```bash
cd /opt/party && git pull && docker compose up -d --build
```

- [ ] **Step 11: Document the setup**

Replace `README.md`:

```markdown
# Party

Split club tables with people you'd actually want at your table.

## Local development

    docker compose up -d
    cp .env.example .env.local        # then fill in AUTH_SECRET and RESEND_API_KEY
    npx auth secret
    npm install
    npm run db:migrate
    FOUNDER_EMAIL=you@example.com npm run db:seed
    npm run dev

## Tests

    npm test                 # domain — pure, fast, no database
    npm run test:integration # repositories — requires docker compose up

Integration tests need the `party_test` database:

    docker compose exec -T db psql -U party -d party -c "CREATE DATABASE party_test"
    DATABASE_URL=postgres://party:party@localhost:5435/party_test npm run db:migrate

## Production

A single DigitalOcean Droplet running `docker-compose.prod.yml`: Postgres,
the Next.js app, and Caddy as a TLS-terminating reverse proxy.

There is no domain. Caddy serves an `sslip.io` hostname derived from the
Droplet's IP (`143-198-1-2.sslip.io` resolves to `143.198.1.2`), which is a
real public name, so Let's Encrypt issues and renews a real certificate.

Deploy:

    ssh root@<droplet-ip>
    cd /opt/party && git pull && docker compose up -d --build

Postgres is not published to the host. Reach it with
`docker compose exec db psql -U party party`.

### Known limitation: email

`EMAIL_FROM` uses Resend's shared test sender, which only delivers to the
address registered on the Resend account. Magic links therefore reach the
founder and nobody else, so real members cannot yet sign themselves in.

Fixing it does not touch application code — replace the provider in
`lib/auth.ts` with either a verified Resend domain or the Nodemailer provider
pointed at any SMTP mailbox.

## Architecture

Business logic lives in `lib/domain/**` as plain TypeScript with no framework
imports — a lint rule enforces this. Persistence sits behind repository
interfaces in `lib/domain/**/ports.ts`, implemented in `lib/db/repositories/**`.
Server actions authenticate, call a domain function, and revalidate; they hold
no business logic.

Money is whole rupiah stored as `bigint`. Never floats.

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for
implementation plans.
```

- [ ] **Step 12: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.prod.yml Caddyfile next.config.ts README.md app/page.tsx
git commit -m "chore: add Droplet deployment with Caddy TLS over sslip.io"
```

## Definition of done

- [ ] `npm test`, `npm run test:integration`, `npm run lint`, and `npm run build` all pass.
- [ ] The lint rule has been observed rejecting a framework import from `lib/domain`.
- [ ] The concurrent-redemption test has been observed failing against a naive check-then-act implementation.
- [ ] A stranger requesting a magic link receives nothing and creates no rows, verified in production.
- [ ] `npm run db:seed` run twice produces no duplicates.
- [ ] The production site serves a valid certificate on its `sslip.io` hostname.
- [ ] A second account has redeemed a real code and signed in — via the token escape hatch, since the test sender cannot reach it.

**Not done, and known:** real members cannot sign themselves in until `EMAIL_FROM` points at a verified domain or an SMTP mailbox. Plan 2 is unblocked by this — listings, requests, and approvals can all be built and tested with seeded accounts — but the product cannot be handed to anyone until it is resolved.

## What Plan 2 picks up

Venue selection, listing creation, the feed, join requests, and the approval flow with the row-locked oversell guard. The `table_listings`, `seat_requests`, and `seat_payments` tables already exist with their constraints; Plan 2 writes the domain logic and screens on top of them.
