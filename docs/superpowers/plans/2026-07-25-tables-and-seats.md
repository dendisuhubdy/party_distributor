# Tables & Seats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host list an already-booked table with a fixed price per seat, let members find it and request a seat, and let the host approve, decline, or remove people — without ever overselling the table.

**Architecture:** Unchanged from Plan 1. Business logic is plain TypeScript in `lib/domain/tables/**` and `lib/domain/seats/**` with no framework imports, tested against an in-memory fake. Persistence sits behind the `TablesRepository` and `SeatsRepository` ports, implemented once in `lib/db/repositories/**` and tested against real PostgreSQL. Server actions authenticate, call a domain function, revalidate, and redirect.

**Tech Stack:** Next.js 15, TypeScript, PostgreSQL 16, Drizzle ORM, Auth.js v5, Tailwind CSS, Vitest, Docker Compose. No new dependencies.

This plan is #2 of 3. Plan 1 delivered invite → account → sign in. This plan delivers list → find → request → approve. Plan 3 adds payment tracking and email.

**Depends on:** `docs/superpowers/plans/2026-07-25-foundation-and-membership.md`, fully executed.
**Source spec:** `docs/superpowers/specs/2026-07-25-party-table-splitting-design.md`

## Global Constraints

Every task's requirements implicitly include this section. These carry over from Plan 1 unchanged.

- **`lib/domain/**` must not import from `next`, `react`, `next-auth`, `drizzle-orm`, or `@/lib/db`.** The ESLint rule added in Plan 1 Task 1 fails the build on violation.
- **No `Date.now()` or `new Date()` inside `lib/domain/**`.** Time enters through an injected `now: () => Date`.
- **Money is whole rupiah as `number`, persisted as `bigint`.** Never a float. Format only through `formatRupiah`.
- **Every database identifier is `snake_case`; every TypeScript identifier is `camelCase`.**
- **All timestamps are `timestamp with time zone`.**
- **TDD is mandatory.** Write the failing test, watch it fail for the right reason, then implement.
- **Commit messages use Conventional Commits.**

## New in this plan: every event time is Bali time

Every venue in v1 is in Bali, which is UTC+8 year-round — Indonesia has never observed daylight saving. That single fact lets the app avoid a timezone library entirely, but only if it is applied deliberately rather than by accident.

The trap is `<input type="datetime-local">`. It yields a string like `2026-08-15T22:00` with no offset, and `new Date('2026-08-15T22:00')` interprets it in *the running process's* local timezone. In a Docker container that is UTC, so a host who types 22:00 gets a table starting at 06:00 the next morning. The bug is invisible in local development on a laptop set to Bali time and appears only in production.

Task 2 therefore introduces explicit conversion in both directions, and **no other code is permitted to construct a `Date` from a form value**. Display formatting is likewise pinned to `Asia/Makassar`, so a host travelling in Singapore sees their table at the time their guests will see it.

## The schema already exists

Plan 1 Task 3 created `venues`, `table_listings`, `seat_requests`, `seat_payments`, and `email_log` with every constraint. **This plan writes no migrations.** If a task seems to need a schema change, that is a signal the design drifted — stop and re-read Plan 1 Task 3 before adding one.

Three constraints in particular are load-bearing here, and the domain code is written assuming they hold:

- `one_active_seat_request_per_user_per_table` — a partial unique index over `(table_id, user_id)` where status is `pending` or `approved`.
- `seat_request_user_is_not_host` — a check constraint, backed by the composite foreign key `seat_requests_table_host_fk` that keeps the denormalized `host_id` honest.
- `seats_offered_positive` and `seat_price_non_negative` check constraints on `table_listings`.

## File structure

```
lib/
├─ domain/
│  ├─ event-time.ts                   Bali wall-clock ↔ Date, display formatting
│  ├─ tables/
│  │  ├─ types.ts                     Venue, TableListing, ListingSummary
│  │  ├─ ports.ts                     TablesRepository, TablesDeps
│  │  ├─ venues.ts                    findOrCreateVenue
│  │  ├─ derive.ts                    deriveListingState (full / past / spots left)
│  │  ├─ list-feed.ts                 listFeed
│  │  ├─ create-listing.ts            createListing
│  │  └─ manage-listing.ts            editListing, cancelListing
│  └─ seats/
│     ├─ types.ts                     SeatRequest, RosterEntry, HeldSeat
│     ├─ ports.ts                     SeatsRepository, SeatsDeps, ApproveOutcome
│     ├─ request-seat.ts              requestSeat, withdrawSeat
│     └─ decide-seat.ts               approveSeat, declineSeat, removeSeat
├─ db/repositories/
│  ├─ tables.ts                       PostgresTablesRepository
│  └─ seats.ts                        PostgresSeatsRepository
├─ tables-service.ts                  tablesDeps
└─ seats-service.ts                   seatsDeps

app/
├─ nav.tsx                            Signed-in navigation
├─ page.tsx                           Feed (replaces Plan 1's placeholder)
├─ listing-card.tsx                   Shared feed/roster card
├─ me/page.tsx                        Tables I host, seats I hold
└─ tables/
   ├─ new/{page.tsx,form.tsx,actions.ts}
   └─ [id]/
      ├─ {page.tsx,request-form.tsx,actions.ts}
      └─ manage/{page.tsx,decision-buttons.tsx,edit-form.tsx,actions.ts}

tests/
├─ support/fake-party-repository.ts   One fake implementing BOTH ports
├─ domain/{event-time,tables,seats}/
└─ integration/{tables-repository,seats-repository}.test.ts
```

One fake implements both `TablesRepository` and `SeatsRepository` over a single in-memory store. Two separate fakes would each need their own listings and would drift apart the first time a cancel cascade had to see seat requests.

---

### Task 1: Tables module foundations — types, ports, and venues

Establishes the vocabulary every later task uses, and delivers one small use case so the shape is proven rather than asserted.

**Files:**
- Modify: `lib/domain/errors.ts`
- Create: `lib/domain/tables/types.ts`, `lib/domain/tables/ports.ts`, `lib/domain/tables/venues.ts`
- Create: `tests/support/fake-party-repository.ts`
- Test: `tests/domain/tables/venues.test.ts`

**Interfaces:**
- Consumes: `DomainError` and `Rupiah` from Plan 1.
- Produces: `Venue`, `TableListing`, `ListingSummary`, `NewListing`, `ListingPatch`, `FeedRange`, `CancelCascade`, `TablesRepository`, `TablesDeps`; `findOrCreateVenue(deps, input): Promise<Venue>`; `FakePartyRepository` for every later domain test.

- [ ] **Step 1: Add the error codes this plan needs**

In `lib/domain/errors.ts`, the `// listings (Plan 2)` and `// seats (Plan 2)` groups already exist. Add two codes that Plan 1 did not anticipate.

To the listings group:

```ts
  | 'venue_not_found'
```

To the seats group:

```ts
  | 'not_seat_owner'
```

`not_seat_owner` is separate from `not_listing_host` because they are opposite failures: one is a guest touching someone else's seat, the other is a non-host touching someone else's table. Collapsing them would make the two most security-relevant checks in the app indistinguishable in logs.

- [ ] **Step 2: Define the tables types**

Create `lib/domain/tables/types.ts`:

```ts
import type { Rupiah } from '../money'

export type ListingStatus = 'open' | 'cancelled'

export interface Venue {
  id: string
  name: string
  city: string
}

export interface TableListing {
  id: string
  hostId: string
  venueId: string
  eventName: string | null
  startsAt: Date
  seatsOffered: number
  seatPrice: Rupiah
  tableTotal: Rupiah | null
  notes: string | null
  paymentLink: string | null
  paymentNote: string | null
  status: ListingStatus
  cancelledAt: Date | null
  createdAt: Date
}

/** The listing plus everything a card or detail page renders, in one round trip. */
export interface ListingSummary {
  listing: TableListing
  venue: Venue
  host: { id: string; name: string; instagramHandle: string | null }
  /**
   * Count of seat requests in the `approved` state. Never stored on the
   * listing — a stored counter drifts and needs a job to maintain it.
   */
  approvedSeats: number
}
```

- [ ] **Step 3: Define the tables port**

Create `lib/domain/tables/ports.ts`:

```ts
import type { ListingStatus, ListingSummary, TableListing, Venue } from './types'
import type { Rupiah } from '../money'

export interface NewListing {
  hostId: string
  venueId: string
  eventName: string | null
  startsAt: Date
  seatsOffered: number
  seatPrice: Rupiah
  tableTotal: Rupiah | null
  notes: string | null
  paymentLink: string | null
  paymentNote: string | null
}

/** Only the fields a host may change. Absent keys are left alone. */
export interface ListingPatch {
  eventName?: string | null
  notes?: string | null
  paymentLink?: string | null
  paymentNote?: string | null
  seatsOffered?: number
  seatPrice?: Rupiah
  startsAt?: Date
}

export interface FeedRange {
  from: Date
  to?: Date
  venueId?: string
}

export interface CancelCascade {
  listing: TableListing
  /** Guests who held an approved seat. Plan 3 emails them; some may be owed a refund. */
  removedUserIds: string[]
  /** Guests whose request was still pending. Plan 3 emails them too, with softer copy. */
  declinedUserIds: string[]
}

export interface TablesRepository {
  listVenues(): Promise<Venue[]>
  findVenueById(venueId: string): Promise<Venue | null>
  /** Case-insensitive, so "savaya" does not create a second Savaya. */
  findVenueByName(name: string): Promise<Venue | null>
  createVenue(input: { name: string; city: string; createdBy: string }): Promise<Venue>

  insertListing(listing: NewListing): Promise<TableListing>
  findListingById(listingId: string): Promise<TableListing | null>
  findListingSummary(listingId: string): Promise<ListingSummary | null>
  /** Open, not-yet-started listings inside the range, soonest first. Full ones included. */
  listUpcomingListings(range: FeedRange): Promise<ListingSummary[]>
  /** Everything this member has ever hosted, newest event first. */
  listListingsHostedBy(userId: string): Promise<ListingSummary[]>
  countApprovedSeats(listingId: string): Promise<number>

  updateListing(listingId: string, patch: ListingPatch): Promise<TableListing>

  /**
   * Cancel the listing and settle every live seat request in one transaction:
   * `approved` becomes `removed`, `pending` becomes `declined`.
   *
   * The spec describes only the approved cascade. Pending requests must go
   * somewhere or they linger forever against a dead table — visible on the
   * host's manage page and blocking the partial unique index that would let
   * that guest ask again if the host relists.
   */
  cancelListing(listingId: string, byUserId: string, at: Date): Promise<CancelCascade>
}

export interface TablesDeps {
  repository: TablesRepository
  now: () => Date
}

export type { ListingStatus }
```

- [ ] **Step 4: Write the failing tests for venue resolution**

Create `tests/domain/tables/venues.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { findOrCreateVenue } from '@/lib/domain/tables/venues'
import { DomainError } from '@/lib/domain/errors'
import { FakePartyRepository } from '../../support/fake-party-repository'

const NOW = new Date('2026-08-01T12:00:00Z')

let repository: FakePartyRepository
let memberId: string

const deps = () => ({ repository, now: () => NOW })

beforeEach(() => {
  repository = new FakePartyRepository()
  memberId = repository.seedUser({ name: 'Member' }).id
})

describe('findOrCreateVenue', () => {
  it('creates a venue nobody has listed before', async () => {
    const venue = await findOrCreateVenue(deps(), { name: 'Atlas', city: 'Bali', createdBy: memberId })

    expect(venue.name).toBe('Atlas')
    expect(venue.city).toBe('Bali')
    expect(repository.venues).toHaveLength(1)
  })

  it('reuses an existing venue instead of creating a near-duplicate', async () => {
    const seeded = repository.seedVenue({ name: 'Savaya', city: 'Bali' })

    const venue = await findOrCreateVenue(deps(), { name: 'savaya', city: 'Bali', createdBy: memberId })

    expect(venue.id).toBe(seeded.id)
    expect(repository.venues).toHaveLength(1)
  })

  it('ignores surrounding whitespace when matching', async () => {
    const seeded = repository.seedVenue({ name: 'Miss Fish', city: 'Bali' })

    const venue = await findOrCreateVenue(deps(), { name: '  Miss Fish  ', city: 'Bali', createdBy: memberId })

    expect(venue.id).toBe(seeded.id)
  })

  it('stores the name as typed, not lowercased', async () => {
    const venue = await findOrCreateVenue(deps(), { name: '  Potato Head  ', city: ' Bali ', createdBy: memberId })

    expect(venue.name).toBe('Potato Head')
    expect(venue.city).toBe('Bali')
  })

  it('rejects a blank name or city', async () => {
    for (const input of [
      { name: '   ', city: 'Bali' },
      { name: 'Atlas', city: '  ' },
    ]) {
      await expect(
        findOrCreateVenue(deps(), { ...input, createdBy: memberId }),
        `expected ${JSON.stringify(input)} to be rejected`,
      ).rejects.toBeInstanceOf(DomainError)
    }
  })

  it('rejects a name longer than a venue name plausibly is', async () => {
    await expect(findOrCreateVenue(deps(), {
      name: 'x'.repeat(81), city: 'Bali', createdBy: memberId,
    })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
```

- [ ] **Step 5: Write the shared fake repository**

Create `tests/support/fake-party-repository.ts`. It implements both ports over one store; the seats half is unused until Task 7 but is written now so the two halves cannot drift.

```ts
import type {
  CancelCascade, FeedRange, ListingPatch, NewListing, TablesRepository,
} from '@/lib/domain/tables/ports'
import type { ListingSummary, TableListing, Venue } from '@/lib/domain/tables/types'
import type {
  ApproveOutcome, NewSeatRequest, SeatListing, SeatsRepository,
} from '@/lib/domain/seats/ports'
import type { HeldSeat, RosterEntry, SeatRequest, SeatRequestStatus } from '@/lib/domain/seats/types'

interface FakeUser { id: string; name: string; instagramHandle: string | null }

let counter = 0
const nextId = (prefix: string) => `${prefix}-${++counter}`

export class FakePartyRepository implements TablesRepository, SeatsRepository {
  users: FakeUser[] = []
  venues: Venue[] = []
  listings: TableListing[] = []
  requests: SeatRequest[] = []

  /** Set by a test to make the next approval report a full table. */
  forceApprovalFull = false

  // ---------- seeding ----------

  seedUser(partial: { name: string; instagramHandle?: string | null } = { name: 'Member' }): FakeUser {
    const user = { id: nextId('user'), name: partial.name, instagramHandle: partial.instagramHandle ?? null }
    this.users.push(user)
    return user
  }

  seedVenue(partial: { name: string; city: string }): Venue {
    const venue = { id: nextId('venue'), name: partial.name, city: partial.city }
    this.venues.push(venue)
    return venue
  }

  seedListing(partial: Partial<TableListing> & { hostId: string }): TableListing {
    const listing: TableListing = {
      id: nextId('listing'),
      hostId: partial.hostId,
      venueId: partial.venueId ?? this.seedVenue({ name: 'Savaya', city: 'Bali' }).id,
      eventName: partial.eventName ?? null,
      startsAt: partial.startsAt ?? new Date('2026-09-01T14:00:00Z'),
      seatsOffered: partial.seatsOffered ?? 4,
      seatPrice: partial.seatPrice ?? 2_500_000,
      tableTotal: partial.tableTotal ?? null,
      notes: partial.notes ?? null,
      paymentLink: partial.paymentLink ?? null,
      paymentNote: partial.paymentNote ?? null,
      status: partial.status ?? 'open',
      cancelledAt: partial.cancelledAt ?? null,
      createdAt: partial.createdAt ?? new Date('2026-08-01T00:00:00Z'),
    }
    this.listings.push(listing)
    return listing
  }

  seedRequest(partial: {
    tableId: string; userId: string; status?: SeatRequestStatus; message?: string | null
  }): SeatRequest {
    const listing = this.listings.find((l) => l.id === partial.tableId)
    const request: SeatRequest = {
      id: nextId('request'),
      tableId: partial.tableId,
      hostId: listing?.hostId ?? 'unknown-host',
      userId: partial.userId,
      message: partial.message ?? null,
      status: partial.status ?? 'pending',
      decidedAt: null,
      decidedBy: null,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    }
    this.requests.push(request)
    return request
  }

  // ---------- TablesRepository ----------

  async listVenues(): Promise<Venue[]> {
    return [...this.venues].sort((a, b) => a.name.localeCompare(b.name))
  }

  async findVenueById(venueId: string): Promise<Venue | null> {
    return this.venues.find((v) => v.id === venueId) ?? null
  }

  async findVenueByName(name: string): Promise<Venue | null> {
    const needle = name.trim().toLowerCase()
    return this.venues.find((v) => v.name.trim().toLowerCase() === needle) ?? null
  }

  async createVenue(input: { name: string; city: string; createdBy: string }): Promise<Venue> {
    return this.seedVenue({ name: input.name, city: input.city })
  }

  async insertListing(listing: NewListing): Promise<TableListing> {
    return this.seedListing(listing)
  }

  async findListingById(listingId: string): Promise<TableListing | null> {
    return this.listings.find((l) => l.id === listingId) ?? null
  }

  private summarize(listing: TableListing): ListingSummary {
    const venue = this.venues.find((v) => v.id === listing.venueId)!
    const host = this.users.find((u) => u.id === listing.hostId)
      ?? { id: listing.hostId, name: 'Host', instagramHandle: null }
    return {
      listing,
      venue,
      host: { id: host.id, name: host.name, instagramHandle: host.instagramHandle },
      approvedSeats: this.requests.filter((r) => r.tableId === listing.id && r.status === 'approved').length,
    }
  }

  async findListingSummary(listingId: string): Promise<ListingSummary | null> {
    const listing = await this.findListingById(listingId)
    return listing ? this.summarize(listing) : null
  }

  async listUpcomingListings(range: FeedRange): Promise<ListingSummary[]> {
    return this.listings
      .filter((l) => l.status === 'open')
      .filter((l) => l.startsAt.getTime() > range.from.getTime())
      .filter((l) => (range.to ? l.startsAt.getTime() < range.to.getTime() : true))
      .filter((l) => (range.venueId ? l.venueId === range.venueId : true))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((l) => this.summarize(l))
  }

  async listListingsHostedBy(userId: string): Promise<ListingSummary[]> {
    return this.listings
      .filter((l) => l.hostId === userId)
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
      .map((l) => this.summarize(l))
  }

  async countApprovedSeats(listingId: string): Promise<number> {
    return this.requests.filter((r) => r.tableId === listingId && r.status === 'approved').length
  }

  async updateListing(listingId: string, patch: ListingPatch): Promise<TableListing> {
    const listing = this.listings.find((l) => l.id === listingId)!
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (listing as Record<string, unknown>)[key] = value
    }
    return listing
  }

  async cancelListing(listingId: string, byUserId: string, at: Date): Promise<CancelCascade> {
    const listing = this.listings.find((l) => l.id === listingId)!
    listing.status = 'cancelled'
    listing.cancelledAt = at

    const removedUserIds: string[] = []
    const declinedUserIds: string[] = []

    for (const request of this.requests.filter((r) => r.tableId === listingId)) {
      if (request.status === 'approved') {
        request.status = 'removed'
        removedUserIds.push(request.userId)
      } else if (request.status === 'pending') {
        request.status = 'declined'
        declinedUserIds.push(request.userId)
      } else {
        continue
      }
      request.decidedAt = at
      request.decidedBy = byUserId
    }

    return { listing, removedUserIds, declinedUserIds }
  }

  // ---------- SeatsRepository ----------

  async findListingForSeats(listingId: string): Promise<SeatListing | null> {
    const listing = await this.findListingById(listingId)
    if (!listing) return null
    return {
      id: listing.id,
      hostId: listing.hostId,
      startsAt: listing.startsAt,
      seatsOffered: listing.seatsOffered,
      seatPrice: listing.seatPrice,
      status: listing.status,
    }
  }

  async findActiveRequest(listingId: string, userId: string): Promise<SeatRequest | null> {
    return this.requests.find(
      (r) => r.tableId === listingId && r.userId === userId
        && (r.status === 'pending' || r.status === 'approved'),
    ) ?? null
  }

  async insertRequest(input: NewSeatRequest): Promise<SeatRequest> {
    return this.seedRequest({ tableId: input.tableId, userId: input.userId, message: input.message })
  }

  async findRequestById(requestId: string): Promise<SeatRequest | null> {
    return this.requests.find((r) => r.id === requestId) ?? null
  }

  async listRequestsForListing(listingId: string): Promise<RosterEntry[]> {
    return this.requests
      .filter((r) => r.tableId === listingId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((request) => {
        const user = this.users.find((u) => u.id === request.userId)
          ?? { id: request.userId, name: 'Guest', instagramHandle: null }
        return { request, user }
      })
  }

  async listSeatsHeldBy(userId: string): Promise<HeldSeat[]> {
    return this.requests
      .filter((r) => r.userId === userId && (r.status === 'pending' || r.status === 'approved'))
      .map((request) => ({ request, listing: this.summarize(this.listings.find((l) => l.id === request.tableId)!) }))
      .sort((a, b) => a.listing.listing.startsAt.getTime() - b.listing.listing.startsAt.getTime())
  }

  async approveIfSeatAvailable(requestId: string, decidedBy: string, at: Date): Promise<ApproveOutcome> {
    const request = this.requests.find((r) => r.id === requestId)
    if (!request || request.status !== 'pending') return { ok: false, reason: 'already_decided' }

    const listing = this.listings.find((l) => l.id === request.tableId)!
    const approved = await this.countApprovedSeats(listing.id)

    if (this.forceApprovalFull || approved >= listing.seatsOffered) {
      this.forceApprovalFull = false
      return { ok: false, reason: 'table_full' }
    }

    request.status = 'approved'
    request.decidedAt = at
    request.decidedBy = decidedBy
    return { ok: true, request }
  }

  async setRequestStatus(
    requestId: string, status: SeatRequestStatus, at: Date, decidedBy: string,
  ): Promise<SeatRequest> {
    const request = this.requests.find((r) => r.id === requestId)!
    request.status = status
    request.decidedAt = at
    request.decidedBy = decidedBy
    return request
  }
}
```

- [ ] **Step 6: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/tables/venues` (and, from the fake, `@/lib/domain/seats/ports` — those arrive in Task 7). If the only errors are unresolved imports, that is the right kind of failure.

- [ ] **Step 7: Implement venue resolution**

Create `lib/domain/tables/venues.ts`:

```ts
import { DomainError } from '../errors'
import type { TablesDeps } from './ports'
import type { Venue } from './types'

export const MAX_VENUE_NAME_LENGTH = 80

export interface FindOrCreateVenueInput {
  name: string
  city: string
  createdBy: string
}

/**
 * Resolve a typed venue name to a row, creating it only if nothing matches.
 *
 * Matching is case-insensitive and whitespace-insensitive because members will
 * type "savaya", "Savaya " and "SAVAYA" for the same club, and a feed filtered
 * by venue is useless once the same place exists three times. There is no admin
 * UI to merge duplicates in v1, so the cheap guard here is the only guard.
 */
export async function findOrCreateVenue(deps: TablesDeps, input: FindOrCreateVenueInput): Promise<Venue> {
  const name = input.name.trim()
  const city = input.city.trim()

  if (name.length === 0 || city.length === 0) {
    throw new DomainError('invalid_input', 'A venue needs a name and a city.')
  }
  if (name.length > MAX_VENUE_NAME_LENGTH) {
    throw new DomainError('invalid_input', `Venue names are at most ${MAX_VENUE_NAME_LENGTH} characters.`)
  }

  const existing = await deps.repository.findVenueByName(name)
  if (existing) return existing

  return deps.repository.createVenue({ name, city, createdBy: input.createdBy })
}
```

- [ ] **Step 8: Run the tests**

```bash
npm test
```

Expected: the venue tests pass. Tests from Plan 1 still pass.

- [ ] **Step 9: Commit**

```bash
git add lib/domain/errors.ts lib/domain/tables tests/support/fake-party-repository.ts tests/domain/tables
git commit -m "feat: add tables module types, ports, and venue resolution"
```

---

### Task 2: Bali event time

The single highest-risk piece of code in this plan, isolated into one file with no dependencies so it can be tested exhaustively.

**Files:**
- Create: `lib/domain/event-time.ts`
- Test: `tests/domain/event-time.test.ts`

**Interfaces:**
- Consumes: `DomainError` from Plan 1.
- Produces: `BALI_UTC_OFFSET_HOURS`; `parseBaliDateTime(value: string): Date`; `toBaliDateTimeValue(date: Date): string`; `parseBaliDay(value: string): Date`; `formatEventTime(date: Date): string`; `formatEventDay(date: Date): string`. Every `Date` built from user input in this plan comes from `parseBaliDateTime` or `parseBaliDay`, and every event time rendered to a user comes from `formatEventTime` or `formatEventDay`.

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/event-time.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  formatEventDay, formatEventTime, parseBaliDateTime, parseBaliDay, toBaliDateTimeValue,
} from '@/lib/domain/event-time'
import { DomainError } from '@/lib/domain/errors'

describe('parseBaliDateTime', () => {
  it('reads a datetime-local value as Bali wall-clock time, never the server clock', () => {
    // 22:00 in Bali (UTC+8) is 14:00 UTC the same day.
    expect(parseBaliDateTime('2026-08-15T22:00')).toEqual(new Date('2026-08-15T14:00:00.000Z'))
  })

  it('rolls back across midnight correctly', () => {
    // 01:30 on the 16th in Bali is 17:30 on the 15th UTC.
    expect(parseBaliDateTime('2026-08-16T01:30')).toEqual(new Date('2026-08-15T17:30:00.000Z'))
  })

  it('accepts a value carrying seconds, which some browsers append', () => {
    expect(parseBaliDateTime('2026-08-15T22:00:00')).toEqual(new Date('2026-08-15T14:00:00.000Z'))
  })

  it('rejects anything that is not a datetime-local value', () => {
    for (const bad of ['', '2026-08-15', '15/08/2026 22:00', '2026-08-15T22:00Z', 'tomorrow']) {
      expect(() => parseBaliDateTime(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrow(DomainError)
    }
  })

  it('rejects a date that does not exist', () => {
    expect(() => parseBaliDateTime('2026-02-30T22:00')).toThrow(DomainError)
    expect(() => parseBaliDateTime('2026-13-01T22:00')).toThrow(DomainError)
    expect(() => parseBaliDateTime('2026-08-15T25:00')).toThrow(DomainError)
  })

  it('reports rejection as invalid_input', () => {
    try {
      parseBaliDateTime('nope')
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as DomainError).code).toBe('invalid_input')
    }
  })
})

describe('toBaliDateTimeValue', () => {
  it('is the exact inverse of parseBaliDateTime', () => {
    for (const value of ['2026-08-15T22:00', '2026-08-16T01:30', '2026-01-01T00:00', '2026-12-31T23:59']) {
      expect(toBaliDateTimeValue(parseBaliDateTime(value))).toBe(value)
    }
  })

  it('produces a value an input[type=datetime-local] accepts', () => {
    expect(toBaliDateTimeValue(new Date('2026-08-15T14:00:00.000Z'))).toBe('2026-08-15T22:00')
  })
})

describe('parseBaliDay', () => {
  it('resolves a day to midnight at the start of that day in Bali', () => {
    expect(parseBaliDay('2026-08-15')).toEqual(new Date('2026-08-14T16:00:00.000Z'))
  })

  it('rejects anything that is not a plain day', () => {
    for (const bad of ['', '2026-8-15', '2026-08-15T22:00', 'today']) {
      expect(() => parseBaliDay(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrow(DomainError)
    }
  })
})

describe('formatEventTime', () => {
  it('renders in Bali time regardless of where the server is', () => {
    expect(formatEventTime(new Date('2026-08-15T14:00:00.000Z'))).toBe('Sat 15 Aug, 22:00')
  })

  it('renders midnight as 00:00, not 24:00', () => {
    expect(formatEventTime(new Date('2026-08-15T16:00:00.000Z'))).toBe('Sun 16 Aug, 00:00')
  })

  it('shows a late-night table on the Bali calendar day, not the UTC one', () => {
    // 23:00 Bali on the 15th is still the 15th UTC, but only just.
    expect(formatEventTime(new Date('2026-08-15T15:00:00.000Z'))).toBe('Sat 15 Aug, 23:00')
    // 01:00 Bali on the 16th is 17:00 UTC on the 15th — the UTC day is wrong.
    expect(formatEventTime(new Date('2026-08-15T17:00:00.000Z'))).toBe('Sun 16 Aug, 01:00')
  })
})

describe('formatEventDay', () => {
  it('renders the Bali calendar day without a time', () => {
    expect(formatEventDay(new Date('2026-08-15T17:00:00.000Z'))).toBe('Sun 16 Aug')
  })
})
```

The last `formatEventTime` test is the one that catches the real bug. A naive implementation that formats in UTC passes the 22:00 case and fails only for tables starting after 4pm UTC — which, for a club in Bali, is all of them.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/event-time`.

- [ ] **Step 3: Implement**

Create `lib/domain/event-time.ts`:

```ts
import { DomainError } from './errors'

/**
 * Bali is WITA, UTC+8, all year. Indonesia has never observed daylight saving,
 * so a fixed offset is correct rather than merely convenient. If a venue in
 * another timezone is ever added, this constant becomes a per-venue column and
 * every function here takes the venue's zone — that is the intended seam.
 */
export const BALI_UTC_OFFSET_HOURS = 8

const BALI_TIME_ZONE = 'Asia/Makassar'

const DATETIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

function toUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day, hour - BALI_UTC_OFFSET_HOURS, minute))

  // Date.UTC silently rolls 30 February into 2 March. Round-tripping the day
  // fields catches that, and catches an hour of 25 the same way.
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute
  ) {
    throw new DomainError('invalid_input', 'That is not a real date and time.')
  }

  return date
}

/**
 * Read an `<input type="datetime-local">` value as Bali wall-clock time.
 *
 * `new Date('2026-08-15T22:00')` is NOT equivalent: it resolves against the
 * running process's timezone, which is UTC inside the production container. A
 * host typing 22:00 would get a table starting at 06:00 the next morning, and
 * the bug would be invisible on a laptop set to Bali time.
 */
export function parseBaliDateTime(value: string): Date {
  const match = DATETIME_LOCAL.exec(value.trim())
  if (!match) {
    throw new DomainError('invalid_input', 'Pick a date and time for the table.')
  }
  const [, year, month, day, hour, minute] = match
  return toUtc(Number(year), Number(month), Number(day), Number(hour), Number(minute))
}

/** The inverse, for prefilling a datetime-local input from a stored listing. */
export function toBaliDateTimeValue(date: Date): string {
  const shifted = new Date(date.getTime() + BALI_UTC_OFFSET_HOURS * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 16)
}

/** Midnight at the start of a `YYYY-MM-DD` day in Bali. Used by the feed's date filter. */
export function parseBaliDay(value: string): Date {
  const match = DAY.exec(value.trim())
  if (!match) {
    throw new DomainError('invalid_input', 'Pick a date.')
  }
  const [, year, month, day] = match
  return toUtc(Number(year), Number(month), Number(day), 0, 0)
}

function parts(date: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const formatted = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: BALI_TIME_ZONE })
    .formatToParts(date)
  return Object.fromEntries(formatted.map((part) => [part.type, part.value]))
}

/**
 * Assembled from formatToParts rather than returned by format() because the
 * separators Intl chooses vary between ICU versions, which would make these
 * strings — and their tests — unstable across Node upgrades.
 */
export function formatEventTime(date: Date): string {
  const p = parts(date, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`
}

export function formatEventDay(date: Date): string {
  const p = parts(date, { weekday: 'short', day: 'numeric', month: 'short' })
  return `${p.weekday} ${p.day} ${p.month}`
}
```

`hourCycle: 'h23'` rather than `hour12: false` is deliberate: with `hour12: false`, some ICU versions render midnight as `24:00`, which reads as an error to a user and breaks the test above.

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npm test
```

Expected: all event-time tests pass.

- [ ] **Step 5: Prove the timezone handling is real, not accidental**

The tests above pass on a laptop set to Bali time even if the implementation is wrong. Run them as production will:

```bash
TZ=UTC npm test
TZ=America/New_York npm test
```

Expected: identical results. If any event-time test is sensitive to `TZ`, a `new Date(string)` or a `getHours()` has crept in — find it before continuing.

- [ ] **Step 6: Commit**

```bash
git add lib/domain/event-time.ts tests/domain/event-time.test.ts
git commit -m "feat: add Bali wall-clock parsing and event time formatting"
```

---

### Task 3: Derived listing state and the feed query

Neither "full" nor "past" is stored. This task is where they come from.

**Files:**
- Create: `lib/domain/tables/derive.ts`, `lib/domain/tables/list-feed.ts`
- Test: `tests/domain/tables/derive.test.ts`, `tests/domain/tables/list-feed.test.ts`

**Interfaces:**
- Consumes: `TablesDeps`, `ListingSummary` (Task 1); `parseBaliDay` (Task 2).
- Produces: `interface ListingState { isCancelled, isPast, isFull, spotsLeft, isOpenForRequests }`; `deriveListingState(listing, approvedSeats, now): ListingState`; `deriveSummaryState(summary, now): ListingState`; `listFeed(deps, query): Promise<ListingSummary[]>`; `interface FeedQuery { venueId?, fromDay?, toDay? }`.

- [ ] **Step 1: Write the failing tests for derived state**

Create `tests/domain/tables/derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deriveListingState } from '@/lib/domain/tables/derive'
import type { ListingStatus } from '@/lib/domain/tables/types'

const NOW = new Date('2026-08-01T12:00:00Z')

const listing = (overrides: Partial<{ status: ListingStatus; startsAt: Date; seatsOffered: number }> = {}) => ({
  status: overrides.status ?? ('open' as ListingStatus),
  startsAt: overrides.startsAt ?? new Date('2026-09-01T14:00:00Z'),
  seatsOffered: overrides.seatsOffered ?? 4,
})

describe('deriveListingState', () => {
  it('reports an upcoming table with room as open for requests', () => {
    const state = deriveListingState(listing(), 1, NOW)

    expect(state).toEqual({
      isCancelled: false, isPast: false, isFull: false, spotsLeft: 3, isOpenForRequests: true,
    })
  })

  it('derives full from the approved count, never from a stored flag', () => {
    const state = deriveListingState(listing({ seatsOffered: 4 }), 4, NOW)

    expect(state.isFull).toBe(true)
    expect(state.spotsLeft).toBe(0)
    expect(state.isOpenForRequests).toBe(false)
  })

  it('never reports negative spots, even if the data is somehow inconsistent', () => {
    const state = deriveListingState(listing({ seatsOffered: 4 }), 6, NOW)

    expect(state.spotsLeft).toBe(0)
    expect(state.isFull).toBe(true)
  })

  it('derives past from the start time', () => {
    const state = deriveListingState(listing({ startsAt: new Date('2026-07-01T14:00:00Z') }), 0, NOW)

    expect(state.isPast).toBe(true)
    expect(state.isOpenForRequests).toBe(false)
  })

  it('treats a table starting exactly now as already past', () => {
    const state = deriveListingState(listing({ startsAt: NOW }), 0, NOW)

    expect(state.isPast).toBe(true)
  })

  it('closes a cancelled table to requests even when it is upcoming and empty', () => {
    const state = deriveListingState(listing({ status: 'cancelled' }), 0, NOW)

    expect(state.isCancelled).toBe(true)
    expect(state.isOpenForRequests).toBe(false)
    expect(state.spotsLeft).toBe(4)
  })
})
```

The "exactly now" test records a decision: a table that has started is past. This is the opposite of the invite rule in Plan 1, where a code expiring exactly now is still valid. The asymmetry is intentional — an invite's expiry is a deadline you may meet, while a party's start time is a moment after which joining is pointless.

- [ ] **Step 2: Write the failing tests for the feed query**

Create `tests/domain/tables/list-feed.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { listFeed } from '@/lib/domain/tables/list-feed'
import { DomainError } from '@/lib/domain/errors'
import { FakePartyRepository } from '../../support/fake-party-repository'

const NOW = new Date('2026-08-01T12:00:00Z')

let repository: FakePartyRepository
let hostId: string
let savaya: string
let missFish: string

const deps = () => ({ repository, now: () => NOW })

beforeEach(() => {
  repository = new FakePartyRepository()
  hostId = repository.seedUser({ name: 'Host' }).id
  savaya = repository.seedVenue({ name: 'Savaya', city: 'Bali' }).id
  missFish = repository.seedVenue({ name: 'Miss Fish', city: 'Bali' }).id
})

describe('listFeed', () => {
  it('returns upcoming open tables soonest first', async () => {
    repository.seedListing({ hostId, venueId: savaya, startsAt: new Date('2026-09-10T14:00:00Z') })
    repository.seedListing({ hostId, venueId: savaya, startsAt: new Date('2026-08-05T14:00:00Z') })

    const feed = await listFeed(deps(), {})

    expect(feed.map((s) => s.listing.startsAt)).toEqual([
      new Date('2026-08-05T14:00:00Z'),
      new Date('2026-09-10T14:00:00Z'),
    ])
  })

  it('hides tables that have already started', async () => {
    repository.seedListing({ hostId, venueId: savaya, startsAt: new Date('2026-07-20T14:00:00Z') })

    expect(await listFeed(deps(), {})).toHaveLength(0)
  })

  it('hides cancelled tables', async () => {
    repository.seedListing({ hostId, venueId: savaya, status: 'cancelled' })

    expect(await listFeed(deps(), {})).toHaveLength(0)
  })

  it('keeps full tables visible so the feed does not look dead', async () => {
    const listing = repository.seedListing({ hostId, venueId: savaya, seatsOffered: 1 })
    const guest = repository.seedUser({ name: 'Guest' }).id
    repository.seedRequest({ tableId: listing.id, userId: guest, status: 'approved' })

    const feed = await listFeed(deps(), {})

    expect(feed).toHaveLength(1)
    expect(feed[0].approvedSeats).toBe(1)
  })

  it('filters by venue', async () => {
    repository.seedListing({ hostId, venueId: savaya })
    repository.seedListing({ hostId, venueId: missFish })

    const feed = await listFeed(deps(), { venueId: missFish })

    expect(feed).toHaveLength(1)
    expect(feed[0].venue.name).toBe('Miss Fish')
  })

  it('filters from the start of a Bali day', async () => {
    // 09:00 UTC on 14 Aug is 17:00 Bali on 14 Aug — before the 15th starts.
    repository.seedListing({ hostId, venueId: savaya, startsAt: new Date('2026-08-14T09:00:00Z') })
    repository.seedListing({ hostId, venueId: savaya, startsAt: new Date('2026-08-15T14:00:00Z') })

    const feed = await listFeed(deps(), { fromDay: '2026-08-15' })

    expect(feed).toHaveLength(1)
    expect(feed[0].listing.startsAt).toEqual(new Date('2026-08-15T14:00:00Z'))
  })

  it('includes the whole of the to-day, not just its first instant', async () => {
    // 23:00 Bali on 15 Aug is 15:00 UTC on 15 Aug.
    repository.seedListing({ hostId, venueId: savaya, startsAt: new Date('2026-08-15T15:00:00Z') })

    const feed = await listFeed(deps(), { toDay: '2026-08-15' })

    expect(feed).toHaveLength(1)
  })

  it('ignores blank filter values, which is what an unset form field sends', async () => {
    repository.seedListing({ hostId, venueId: savaya })

    expect(await listFeed(deps(), { venueId: '', fromDay: '', toDay: null })).toHaveLength(1)
  })

  it('rejects a malformed date filter rather than silently ignoring it', async () => {
    await expect(listFeed(deps(), { fromDay: 'yesterday' })).rejects.toBeInstanceOf(DomainError)
  })
})
```

The "whole of the to-day" test is the one worth writing carefully. A range that ends at the *start* of the chosen day silently excludes every table on it — and since every table in this product starts at night, that would exclude all of them.

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failures resolving `@/lib/domain/tables/derive` and `@/lib/domain/tables/list-feed`.

- [ ] **Step 4: Implement derived state**

Create `lib/domain/tables/derive.ts`:

```ts
import type { ListingSummary, TableListing } from './types'

export interface ListingState {
  isCancelled: boolean
  /** The table has started. Joining, withdrawing, and removing all close here. */
  isPast: boolean
  isFull: boolean
  spotsLeft: number
  isOpenForRequests: boolean
}

/**
 * Neither "full" nor "past" is a stored column. A stored counter drifts the
 * first time a row is changed outside the approval path, and a stored
 * time-based flag needs a job to maintain it. Deriving both costs one count
 * that the summary query already carries.
 */
export function deriveListingState(
  listing: Pick<TableListing, 'status' | 'startsAt' | 'seatsOffered'>,
  approvedSeats: number,
  now: Date,
): ListingState {
  const isCancelled = listing.status === 'cancelled'
  // Inclusive: a table starting at exactly `now` has started.
  const isPast = listing.startsAt.getTime() <= now.getTime()
  const spotsLeft = Math.max(0, listing.seatsOffered - approvedSeats)
  const isFull = spotsLeft === 0

  return {
    isCancelled,
    isPast,
    isFull,
    spotsLeft,
    isOpenForRequests: !isCancelled && !isPast && !isFull,
  }
}

export function deriveSummaryState(summary: ListingSummary, now: Date): ListingState {
  return deriveListingState(summary.listing, summary.approvedSeats, now)
}
```

- [ ] **Step 5: Implement the feed query**

Create `lib/domain/tables/list-feed.ts`:

```ts
import { parseBaliDay } from '../event-time'
import type { TablesDeps } from './ports'
import type { ListingSummary } from './types'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface FeedQuery {
  venueId?: string | null
  /** `YYYY-MM-DD` in Bali time. Inclusive. */
  fromDay?: string | null
  /** `YYYY-MM-DD` in Bali time. Inclusive — the whole day is in range. */
  toDay?: string | null
}

/** Search params arrive as '' when a select is left on its blank option. */
const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value === ''

export async function listFeed(deps: TablesDeps, query: FeedQuery): Promise<ListingSummary[]> {
  const now = deps.now()

  // A from-day in the past cannot resurrect tables that already started, so the
  // effective floor is always the later of the two.
  let from = now
  if (!blank(query.fromDay)) {
    const dayStart = parseBaliDay(query.fromDay!)
    if (dayStart.getTime() > from.getTime()) from = dayStart
  }

  // Exclusive upper bound at the start of the following day, so the entire
  // chosen day is included — every table in this product starts at night.
  const to = blank(query.toDay) ? undefined : new Date(parseBaliDay(query.toDay!).getTime() + MS_PER_DAY)

  return deps.repository.listUpcomingListings({
    from,
    to,
    venueId: blank(query.venueId) ? undefined : query.venueId!,
  })
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npm test
```

Expected: derive and feed tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/domain/tables/derive.ts lib/domain/tables/list-feed.ts tests/domain/tables
git commit -m "feat: derive listing state and add the feed query"
```

---

### Task 4: Creating a listing

**Files:**
- Modify: `lib/domain/money.ts` (export one existing function)
- Create: `lib/domain/tables/create-listing.ts`
- Test: `tests/domain/tables/create-listing.test.ts`

**Interfaces:**
- Consumes: `TablesDeps`, `TableListing` (Task 1); `assertWholeRupiah` (this task); `DomainError`.
- Produces: `createListing(deps, input): Promise<TableListing>`; `MAX_SEATS_OFFERED = 20`; `MAX_EVENT_NAME_LENGTH = 80`; `MAX_NOTES_LENGTH = 500`; `MAX_PAYMENT_NOTE_LENGTH = 200`; `interface CreateListingInput`.

- [ ] **Step 1: Export the rupiah assertion**

`lib/domain/money.ts` keeps `assertWholeRupiah` private. Listing validation needs it. Change one word:

```ts
export function assertWholeRupiah(amount: number): void {
```

Its behaviour is already covered by the money tests from Plan 1 Task 2, so this needs no new test of its own.

- [ ] **Step 2: Write the failing tests**

Create `tests/domain/tables/create-listing.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_SEATS_OFFERED, createListing } from '@/lib/domain/tables/create-listing'
import { DomainError } from '@/lib/domain/errors'
import { FakePartyRepository } from '../../support/fake-party-repository'

const NOW = new Date('2026-08-01T12:00:00Z')
const LATER = new Date('2026-09-01T14:00:00Z')

let repository: FakePartyRepository
let hostId: string
let venueId: string

const deps = () => ({ repository, now: () => NOW })

const input = (overrides: Record<string, unknown> = {}) => ({
  hostId,
  venueId,
  eventName: null,
  startsAt: LATER,
  seatsOffered: 4,
  seatPrice: 2_500_000,
  tableTotal: null,
  notes: null,
  paymentLink: null,
  paymentNote: null,
  ...overrides,
}) as Parameters<typeof createListing>[1]

beforeEach(() => {
  repository = new FakePartyRepository()
  hostId = repository.seedUser({ name: 'Host' }).id
  venueId = repository.seedVenue({ name: 'Savaya', city: 'Bali' }).id
})

describe('createListing', () => {
  it('creates an open listing owned by the host', async () => {
    const listing = await createListing(deps(), input())

    expect(listing.hostId).toBe(hostId)
    expect(listing.venueId).toBe(venueId)
    expect(listing.seatsOffered).toBe(4)
    expect(listing.seatPrice).toBe(2_500_000)
    expect(listing.status).toBe('open')
    expect(listing.cancelledAt).toBeNull()
  })

  it('trims optional text and stores blanks as null', async () => {
    const listing = await createListing(deps(), input({
      eventName: '  Peggy Gou  ', notes: '   ', paymentNote: '  GoPay  ',
    }))

    expect(listing.eventName).toBe('Peggy Gou')
    expect(listing.notes).toBeNull()
    expect(listing.paymentNote).toBe('GoPay')
  })

  it('accepts an optional table total the host wants to show publicly', async () => {
    const listing = await createListing(deps(), input({ tableTotal: 25_000_000 }))

    expect(listing.tableTotal).toBe(25_000_000)
  })

  it('rejects a venue that does not exist', async () => {
    await expect(createListing(deps(), input({ venueId: 'nope' })))
      .rejects.toMatchObject({ code: 'venue_not_found' })
  })

  it('rejects a start time in the past', async () => {
    await expect(createListing(deps(), input({ startsAt: new Date('2026-07-01T14:00:00Z') })))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects a start time of exactly now', async () => {
    await expect(createListing(deps(), input({ startsAt: NOW })))
      .rejects.toBeInstanceOf(DomainError)
  })

  it('rejects a seat count that is not a sensible number of guests', async () => {
    for (const seatsOffered of [0, -1, 1.5, MAX_SEATS_OFFERED + 1]) {
      await expect(
        createListing(deps(), input({ seatsOffered })),
        `expected ${seatsOffered} seats to be rejected`,
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('allows a single seat, which is the common case for one spare spot', async () => {
    const listing = await createListing(deps(), input({ seatsOffered: 1 }))

    expect(listing.seatsOffered).toBe(1)
  })

  it('allows a free seat but rejects a negative one', async () => {
    expect((await createListing(deps(), input({ seatPrice: 0 }))).seatPrice).toBe(0)

    await expect(createListing(deps(), input({ seatPrice: -1 })))
      .rejects.toMatchObject({ code: 'invalid_amount' })
  })

  it('rejects a fractional seat price rather than rounding it', async () => {
    await expect(createListing(deps(), input({ seatPrice: 2_500_000.5 })))
      .rejects.toMatchObject({ code: 'invalid_amount' })
  })

  it('accepts an http or https payment link and rejects anything else', async () => {
    const ok = await createListing(deps(), input({ paymentLink: ' https://gopay.example/abc ' }))
    expect(ok.paymentLink).toBe('https://gopay.example/abc')

    for (const bad of ['gopay.example/abc', 'javascript:alert(1)', 'mailto:me@example.com']) {
      await expect(
        createListing(deps(), input({ paymentLink: bad })),
        `expected ${JSON.stringify(bad)} to be rejected`,
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('rejects text fields longer than their limits', async () => {
    await expect(createListing(deps(), input({ eventName: 'x'.repeat(81) })))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createListing(deps(), input({ notes: 'x'.repeat(501) })))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createListing(deps(), input({ paymentNote: 'x'.repeat(201) })))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })
})
```

Rejecting `javascript:` is not theoretical. The payment link is rendered as an anchor on the listing page, and any host can set it — a curated community is not a trusted one when one member's account is compromised.

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/tables/create-listing`.

- [ ] **Step 4: Implement**

Create `lib/domain/tables/create-listing.ts`:

```ts
import { DomainError } from '../errors'
import { assertWholeRupiah, type Rupiah } from '../money'
import type { TablesDeps } from './ports'
import type { TableListing } from './types'

/** A club table seats a party, not a wedding. The cap catches typos, not ambition. */
export const MAX_SEATS_OFFERED = 20
export const MAX_EVENT_NAME_LENGTH = 80
export const MAX_NOTES_LENGTH = 500
export const MAX_PAYMENT_NOTE_LENGTH = 200

export interface CreateListingInput {
  hostId: string
  venueId: string
  eventName: string | null
  startsAt: Date
  seatsOffered: number
  seatPrice: Rupiah
  tableTotal: Rupiah | null
  notes: string | null
  paymentLink: string | null
  paymentNote: string | null
}

export function cleanText(value: string | null, max: number, label: string): string | null {
  const trimmed = (value ?? '').trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > max) {
    throw new DomainError('invalid_input', `${label} is at most ${max} characters.`)
  }
  return trimmed
}

export function cleanPaymentLink(value: string | null): string | null {
  const trimmed = (value ?? '').trim()
  if (trimmed.length === 0) return null

  // Anchored, not a substring match: "javascript:alert(1)#https://x" must fail.
  if (!/^https?:\/\/\S+$/i.test(trimmed)) {
    throw new DomainError('invalid_input', 'A payment link has to start with http:// or https://.')
  }
  return trimmed
}

export function assertSeatPrice(seatPrice: Rupiah): void {
  if (seatPrice < 0) {
    throw new DomainError('invalid_amount', 'A seat price cannot be negative.')
  }
  assertWholeRupiah(seatPrice)
}

export function assertSeatsOffered(seatsOffered: number): void {
  if (!Number.isInteger(seatsOffered) || seatsOffered < 1 || seatsOffered > MAX_SEATS_OFFERED) {
    throw new DomainError(
      'invalid_input',
      `Offer between 1 and ${MAX_SEATS_OFFERED} seats.`,
      { seatsOffered },
    )
  }
}

export async function createListing(deps: TablesDeps, input: CreateListingInput): Promise<TableListing> {
  const venue = await deps.repository.findVenueById(input.venueId)
  if (!venue) {
    throw new DomainError('venue_not_found', 'Pick a venue, or add a new one.')
  }

  if (input.startsAt.getTime() <= deps.now().getTime()) {
    throw new DomainError('invalid_input', 'A table has to start in the future.')
  }

  assertSeatsOffered(input.seatsOffered)
  assertSeatPrice(input.seatPrice)

  if (input.tableTotal !== null) {
    assertSeatPrice(input.tableTotal)
  }

  return deps.repository.insertListing({
    hostId: input.hostId,
    venueId: input.venueId,
    // `seats_offered` counts guest seats only — never the host's own place. The
    // host's cost is not modelled at all, because a fixed seat price means no
    // calculation ever needs it.
    seatsOffered: input.seatsOffered,
    seatPrice: input.seatPrice,
    // Display-only. Participates in no calculation; it exists so a host can show
    // their math, which has social value in a curated community and no other.
    tableTotal: input.tableTotal,
    startsAt: input.startsAt,
    eventName: cleanText(input.eventName, MAX_EVENT_NAME_LENGTH, 'The event name'),
    notes: cleanText(input.notes, MAX_NOTES_LENGTH, 'Notes'),
    paymentNote: cleanText(input.paymentNote, MAX_PAYMENT_NOTE_LENGTH, 'The payment note'),
    paymentLink: cleanPaymentLink(input.paymentLink),
  })
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

Expected: all create-listing tests pass and lint is clean.

- [ ] **Step 6: Commit and push**

```bash
git add lib/domain/money.ts lib/domain/tables/create-listing.ts tests/domain/tables/create-listing.test.ts
git commit -m "feat: add listing creation with validation"
git push
```

---

### Task 5: Editing and cancelling a listing

The two host mutations that operate on a listing that already exists. They share every guard, which is why they share a file.

**Files:**
- Create: `lib/domain/tables/manage-listing.ts`
- Test: `tests/domain/tables/manage-listing.test.ts`

**Interfaces:**
- Consumes: `TablesDeps`, `ListingPatch`, `CancelCascade` (Task 1); `deriveListingState` (Task 3); validators from Task 4.
- Produces: `editListing(deps, input): Promise<TableListing>`; `cancelListing(deps, input): Promise<CancelCascade>`; `interface EditListingInput`; `interface CancelListingInput`.

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/tables/manage-listing.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { cancelListing, editListing } from '@/lib/domain/tables/manage-listing'
import { DomainError } from '@/lib/domain/errors'
import { FakePartyRepository } from '../../support/fake-party-repository'

const NOW = new Date('2026-08-01T12:00:00Z')
const LATER = new Date('2026-09-01T14:00:00Z')

let repository: FakePartyRepository
let hostId: string
let strangerId: string
let guestId: string

const deps = () => ({ repository, now: () => NOW })

beforeEach(() => {
  repository = new FakePartyRepository()
  hostId = repository.seedUser({ name: 'Host' }).id
  strangerId = repository.seedUser({ name: 'Stranger' }).id
  guestId = repository.seedUser({ name: 'Guest' }).id
})

const openListing = () => repository.seedListing({ hostId, startsAt: LATER, seatsOffered: 4, seatPrice: 2_500_000 })

describe('editListing', () => {
  it('lets the host change the soft fields at any time', async () => {
    const listing = openListing()

    const updated = await editListing(deps(), {
      listingId: listing.id,
      hostId,
      patch: { eventName: '  Peggy Gou  ', notes: 'Bring ID', paymentNote: 'GoPay', paymentLink: 'https://pay.example/x' },
    })

    expect(updated.eventName).toBe('Peggy Gou')
    expect(updated.notes).toBe('Bring ID')
    expect(updated.paymentNote).toBe('GoPay')
    expect(updated.paymentLink).toBe('https://pay.example/x')
  })

  it('clears an optional field when the host blanks it', async () => {
    const listing = repository.seedListing({ hostId, startsAt: LATER, notes: 'Old' })

    const updated = await editListing(deps(), { listingId: listing.id, hostId, patch: { notes: '   ' } })

    expect(updated.notes).toBeNull()
  })

  it('lets the host raise the seat count and change price and time while nobody is approved', async () => {
    const listing = openListing()

    const updated = await editListing(deps(), {
      listingId: listing.id,
      hostId,
      patch: { seatsOffered: 8, seatPrice: 3_000_000, startsAt: new Date('2026-09-02T14:00:00Z') },
    })

    expect(updated.seatsOffered).toBe(8)
    expect(updated.seatPrice).toBe(3_000_000)
    expect(updated.startsAt).toEqual(new Date('2026-09-02T14:00:00Z'))
  })

  it('freezes the seat price once someone has been approved', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    await expect(editListing(deps(), { listingId: listing.id, hostId, patch: { seatPrice: 3_000_000 } }))
      .rejects.toMatchObject({ code: 'listing_locked' })
  })

  it('freezes the start time once someone has been approved', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    await expect(editListing(deps(), {
      listingId: listing.id, hostId, patch: { startsAt: new Date('2026-09-05T14:00:00Z') },
    })).rejects.toMatchObject({ code: 'listing_locked' })
  })

  it('accepts a resubmitted form that repeats the frozen values unchanged', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    const updated = await editListing(deps(), {
      listingId: listing.id,
      hostId,
      patch: { seatPrice: 2_500_000, startsAt: LATER, notes: 'Table 12' },
    })

    expect(updated.notes).toBe('Table 12')
  })

  it('lets the host still raise seats after an approval', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    const updated = await editListing(deps(), { listingId: listing.id, hostId, patch: { seatsOffered: 6 } })

    expect(updated.seatsOffered).toBe(6)
  })

  it('refuses to lower seats below the number already approved', async () => {
    const listing = openListing()
    for (let i = 0; i < 3; i++) {
      repository.seedRequest({ tableId: listing.id, userId: repository.seedUser({ name: `G${i}` }).id, status: 'approved' })
    }

    await expect(editListing(deps(), { listingId: listing.id, hostId, patch: { seatsOffered: 2 } }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('allows lowering seats down to exactly the approved count', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    const updated = await editListing(deps(), { listingId: listing.id, hostId, patch: { seatsOffered: 1 } })

    expect(updated.seatsOffered).toBe(1)
  })

  it('refuses anyone who is not the host', async () => {
    const listing = openListing()

    await expect(editListing(deps(), { listingId: listing.id, hostId: strangerId, patch: { notes: 'mine now' } }))
      .rejects.toMatchObject({ code: 'not_listing_host' })
  })

  it('refuses a listing that does not exist', async () => {
    await expect(editListing(deps(), { listingId: 'nope', hostId, patch: { notes: 'x' } }))
      .rejects.toMatchObject({ code: 'listing_not_found' })
  })

  it('refuses a cancelled or already-started table', async () => {
    const cancelled = repository.seedListing({ hostId, startsAt: LATER, status: 'cancelled' })
    await expect(editListing(deps(), { listingId: cancelled.id, hostId, patch: { notes: 'x' } }))
      .rejects.toMatchObject({ code: 'listing_cancelled' })

    const past = repository.seedListing({ hostId, startsAt: new Date('2026-07-01T14:00:00Z') })
    await expect(editListing(deps(), { listingId: past.id, hostId, patch: { notes: 'x' } }))
      .rejects.toMatchObject({ code: 'listing_past' })
  })

  it('still validates the values it is given', async () => {
    const listing = openListing()

    await expect(editListing(deps(), { listingId: listing.id, hostId, patch: { paymentLink: 'javascript:alert(1)' } }))
      .rejects.toBeInstanceOf(DomainError)
    await expect(editListing(deps(), { listingId: listing.id, hostId, patch: { seatsOffered: 0 } }))
      .rejects.toBeInstanceOf(DomainError)
  })
})

describe('cancelListing', () => {
  it('marks the listing cancelled and stamps the time', async () => {
    const listing = openListing()

    const result = await cancelListing(deps(), { listingId: listing.id, hostId })

    expect(result.listing.status).toBe('cancelled')
    expect(result.listing.cancelledAt).toEqual(NOW)
  })

  it('removes every approved guest and reports them for notification', async () => {
    const listing = openListing()
    const other = repository.seedUser({ name: 'Other' }).id
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })
    repository.seedRequest({ tableId: listing.id, userId: other, status: 'approved' })

    const result = await cancelListing(deps(), { listingId: listing.id, hostId })

    expect(result.removedUserIds.sort()).toEqual([guestId, other].sort())
    expect(repository.requests.every((r) => r.status === 'removed')).toBe(true)
  })

  it('declines pending requests rather than leaving them dangling', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'pending' })

    const result = await cancelListing(deps(), { listingId: listing.id, hostId })

    expect(result.declinedUserIds).toEqual([guestId])
    expect(result.removedUserIds).toEqual([])
  })

  it('leaves already-withdrawn and already-declined requests alone', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'withdrawn' })

    const result = await cancelListing(deps(), { listingId: listing.id, hostId })

    expect(result.removedUserIds).toEqual([])
    expect(result.declinedUserIds).toEqual([])
    expect(repository.requests[0].status).toBe('withdrawn')
  })

  it('refuses anyone who is not the host', async () => {
    const listing = openListing()

    await expect(cancelListing(deps(), { listingId: listing.id, hostId: strangerId }))
      .rejects.toMatchObject({ code: 'not_listing_host' })
  })

  it('refuses to cancel twice', async () => {
    const listing = openListing()
    await cancelListing(deps(), { listingId: listing.id, hostId })

    await expect(cancelListing(deps(), { listingId: listing.id, hostId }))
      .rejects.toMatchObject({ code: 'listing_cancelled' })
  })

  it('refuses to cancel a table that has already started', async () => {
    const past = repository.seedListing({ hostId, startsAt: new Date('2026-07-01T14:00:00Z') })

    await expect(cancelListing(deps(), { listingId: past.id, hostId }))
      .rejects.toMatchObject({ code: 'listing_past' })
  })
})
```

The "accepts a resubmitted form that repeats the frozen values" test is the one that keeps the manage page usable. An edit form posts every field on every submit, so a lock that rejects *any* value for a frozen field — rather than any *change* to it — would make the form permanently unsubmittable the moment one guest is approved.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/tables/manage-listing`.

- [ ] **Step 3: Implement**

Create `lib/domain/tables/manage-listing.ts`:

```ts
import { DomainError } from '../errors'
import {
  MAX_EVENT_NAME_LENGTH, MAX_NOTES_LENGTH, MAX_PAYMENT_NOTE_LENGTH,
  assertSeatPrice, assertSeatsOffered, cleanPaymentLink, cleanText,
} from './create-listing'
import { deriveListingState } from './derive'
import type { CancelCascade, ListingPatch, TablesDeps } from './ports'
import type { TableListing } from './types'

export interface EditListingInput {
  listingId: string
  hostId: string
  patch: ListingPatch
}

export interface CancelListingInput {
  listingId: string
  hostId: string
}

/**
 * Every host mutation shares these four checks, in this order. The order is the
 * error message the host sees, so it runs from most fundamental to least:
 * exists, is yours, is alive, has not happened yet.
 */
async function loadEditableListing(deps: TablesDeps, listingId: string, hostId: string): Promise<TableListing> {
  const listing = await deps.repository.findListingById(listingId)
  if (!listing) {
    throw new DomainError('listing_not_found', 'That table no longer exists.')
  }
  if (listing.hostId !== hostId) {
    throw new DomainError('not_listing_host', 'Only the host can change this table.')
  }
  if (listing.status === 'cancelled') {
    throw new DomainError('listing_cancelled', 'That table was cancelled.')
  }
  if (deriveListingState(listing, 0, deps.now()).isPast) {
    throw new DomainError('listing_past', 'That table has already started.')
  }
  return listing
}

export async function editListing(deps: TablesDeps, input: EditListingInput): Promise<TableListing> {
  const listing = await loadEditableListing(deps, input.listingId, input.hostId)
  const approvedSeats = await deps.repository.countApprovedSeats(listing.id)

  const patch: ListingPatch = {}

  if (input.patch.eventName !== undefined) {
    patch.eventName = cleanText(input.patch.eventName, MAX_EVENT_NAME_LENGTH, 'The event name')
  }
  if (input.patch.notes !== undefined) {
    patch.notes = cleanText(input.patch.notes, MAX_NOTES_LENGTH, 'Notes')
  }
  if (input.patch.paymentNote !== undefined) {
    patch.paymentNote = cleanText(input.patch.paymentNote, MAX_PAYMENT_NOTE_LENGTH, 'The payment note')
  }
  if (input.patch.paymentLink !== undefined) {
    patch.paymentLink = cleanPaymentLink(input.patch.paymentLink)
  }

  if (input.patch.seatsOffered !== undefined && input.patch.seatsOffered !== listing.seatsOffered) {
    assertSeatsOffered(input.patch.seatsOffered)
    if (input.patch.seatsOffered < approvedSeats) {
      throw new DomainError(
        'invalid_input',
        `You have already approved ${approvedSeats} ${approvedSeats === 1 ? 'guest' : 'guests'}. You cannot offer fewer seats than that.`,
        { approvedSeats },
      )
    }
    patch.seatsOffered = input.patch.seatsOffered
  }

  // Price and start time are frozen once anyone has been approved. People agreed
  // to a specific price at a specific time; changing either on them silently is
  // the one thing that would destroy trust in the product. A host who genuinely
  // needs different terms cancels and relists.
  //
  // Note this compares against the CURRENT value rather than rejecting the field
  // outright: the manage form posts every field on every submit, so an unchanged
  // value must be accepted or the form becomes unsubmittable after one approval.
  if (input.patch.seatPrice !== undefined && input.patch.seatPrice !== listing.seatPrice) {
    if (approvedSeats > 0) {
      throw new DomainError('listing_locked', 'You cannot change the price once someone has been approved. Cancel and relist instead.')
    }
    assertSeatPrice(input.patch.seatPrice)
    patch.seatPrice = input.patch.seatPrice
  }

  if (input.patch.startsAt !== undefined && input.patch.startsAt.getTime() !== listing.startsAt.getTime()) {
    if (approvedSeats > 0) {
      throw new DomainError('listing_locked', 'You cannot change the time once someone has been approved. Cancel and relist instead.')
    }
    if (input.patch.startsAt.getTime() <= deps.now().getTime()) {
      throw new DomainError('invalid_input', 'A table has to start in the future.')
    }
    patch.startsAt = input.patch.startsAt
  }

  if (Object.keys(patch).length === 0) return listing

  return deps.repository.updateListing(listing.id, patch)
}

export async function cancelListing(deps: TablesDeps, input: CancelListingInput): Promise<CancelCascade> {
  const listing = await loadEditableListing(deps, input.listingId, input.hostId)

  // The cascade — approved to removed, pending to declined — happens inside the
  // repository's transaction so no guest is ever attached to a cancelled table.
  return deps.repository.cancelListing(listing.id, input.hostId, deps.now())
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

Expected: all manage-listing tests pass.

- [ ] **Step 5: Commit and push**

```bash
git add lib/domain/tables/manage-listing.ts tests/domain/tables/manage-listing.test.ts
git commit -m "feat: add listing editing with frozen terms and cancellation cascade"
git push
```

---

### Task 6: Seat requests — asking and withdrawing

**Files:**
- Create: `lib/domain/seats/types.ts`, `lib/domain/seats/ports.ts`, `lib/domain/seats/request-seat.ts`
- Test: `tests/domain/seats/request-seat.test.ts`

**Interfaces:**
- Consumes: `TablesDeps`-adjacent types from Task 1; `deriveListingState` (Task 3).
- Produces: `SeatRequestStatus`, `SeatRequest`, `RosterEntry`, `HeldSeat`, `SeatListing`, `NewSeatRequest`, `ApproveOutcome`, `SeatsRepository`, `SeatsDeps`; `requestSeat(deps, input): Promise<SeatRequest>`; `withdrawSeat(deps, input): Promise<SeatRequest>`; `MAX_SEAT_MESSAGE_LENGTH = 280`.

- [ ] **Step 1: Define the seats types**

Create `lib/domain/seats/types.ts`:

```ts
import type { ListingSummary } from '../tables/types'

export type SeatRequestStatus = 'pending' | 'approved' | 'declined' | 'withdrawn' | 'removed'

export interface SeatRequest {
  id: string
  tableId: string
  /**
   * A denormalized copy of the listing's host, held honest by the composite
   * foreign key `seat_requests_table_host_fk`. It exists so that "a host cannot
   * take a seat at their own table" can be a CHECK constraint — a CHECK cannot
   * reference another table. Never write it from application code; the
   * repository copies it from the listing.
   */
  hostId: string
  userId: string
  message: string | null
  status: SeatRequestStatus
  decidedAt: Date | null
  decidedBy: string | null
  createdAt: Date
}

export interface RosterEntry {
  request: SeatRequest
  user: { id: string; name: string; instagramHandle: string | null }
}

export interface HeldSeat {
  request: SeatRequest
  listing: ListingSummary
}
```

- [ ] **Step 2: Define the seats port**

Create `lib/domain/seats/ports.ts`:

```ts
import type { Rupiah } from '../money'
import type { ListingStatus } from '../tables/types'
import type { HeldSeat, RosterEntry, SeatRequest, SeatRequestStatus } from './types'

/** The slice of a listing that seat decisions actually need. */
export interface SeatListing {
  id: string
  hostId: string
  startsAt: Date
  seatsOffered: number
  seatPrice: Rupiah
  status: ListingStatus
}

export interface NewSeatRequest {
  tableId: string
  hostId: string
  userId: string
  message: string | null
}

export type ApproveOutcome =
  | { ok: true; request: SeatRequest }
  | { ok: false; reason: 'table_full' | 'already_decided' }

export interface SeatsRepository {
  findListingForSeats(listingId: string): Promise<SeatListing | null>
  findActiveRequest(listingId: string, userId: string): Promise<SeatRequest | null>
  countApprovedSeats(listingId: string): Promise<number>
  insertRequest(input: NewSeatRequest): Promise<SeatRequest>
  findRequestById(requestId: string): Promise<SeatRequest | null>
  /** Every request ever made against the listing, oldest first. */
  listRequestsForListing(listingId: string): Promise<RosterEntry[]>
  /** This member's live seats — pending and approved — soonest event first. */
  listSeatsHeldBy(userId: string): Promise<HeldSeat[]>

  /**
   * Atomically: take a row lock on the listing, count approved seats, and
   * approve the request only if a seat remains. Also records the seat's price
   * as it stands right now.
   *
   * Callers MUST NOT count seats themselves and then call this. Any count taken
   * outside the lock is stale by the time it returns — that is precisely the
   * oversell bug this method exists to make impossible. A caller's own count is
   * useful only for rendering a number on a page.
   *
   * `{ ok: false, reason: 'already_decided' }` means the request left `pending`
   * between the caller's read and this call. It is distinguished from
   * `'table_full'` because the two produce different, and both actionable,
   * messages for the host.
   */
  approveIfSeatAvailable(requestId: string, decidedBy: string, at: Date): Promise<ApproveOutcome>

  setRequestStatus(
    requestId: string, status: SeatRequestStatus, at: Date, decidedBy: string,
  ): Promise<SeatRequest>
}

export interface SeatsDeps {
  repository: SeatsRepository
  now: () => Date
}
```

- [ ] **Step 3: Write the failing tests**

Create `tests/domain/seats/request-seat.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_SEAT_MESSAGE_LENGTH, requestSeat, withdrawSeat } from '@/lib/domain/seats/request-seat'
import { FakePartyRepository } from '../../support/fake-party-repository'

const NOW = new Date('2026-08-01T12:00:00Z')
const LATER = new Date('2026-09-01T14:00:00Z')

let repository: FakePartyRepository
let hostId: string
let guestId: string
let otherId: string

const deps = () => ({ repository, now: () => NOW })

beforeEach(() => {
  repository = new FakePartyRepository()
  hostId = repository.seedUser({ name: 'Host' }).id
  guestId = repository.seedUser({ name: 'Guest' }).id
  otherId = repository.seedUser({ name: 'Other' }).id
})

const openListing = (overrides = {}) =>
  repository.seedListing({ hostId, startsAt: LATER, seatsOffered: 2, ...overrides })

describe('requestSeat', () => {
  it('creates a pending request carrying the guest and the host', async () => {
    const listing = openListing()

    const request = await requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null })

    expect(request.status).toBe('pending')
    expect(request.userId).toBe(guestId)
    expect(request.hostId).toBe(hostId)
    expect(request.tableId).toBe(listing.id)
    expect(request.decidedAt).toBeNull()
  })

  it('keeps a short note for the host and drops a blank one', async () => {
    const listing = openListing()

    const withNote = await requestSeat(deps(), {
      listingId: listing.id, userId: guestId, message: '  Bringing a friend later  ',
    })
    expect(withNote.message).toBe('Bringing a friend later')

    const blank = await requestSeat(deps(), { listingId: listing.id, userId: otherId, message: '   ' })
    expect(blank.message).toBeNull()
  })

  it('rejects a note longer than the limit', async () => {
    const listing = openListing()

    await expect(requestSeat(deps(), {
      listingId: listing.id, userId: guestId, message: 'x'.repeat(MAX_SEAT_MESSAGE_LENGTH + 1),
    })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('refuses a table that does not exist', async () => {
    await expect(requestSeat(deps(), { listingId: 'nope', userId: guestId, message: null }))
      .rejects.toMatchObject({ code: 'listing_not_found' })
  })

  it('refuses a cancelled table', async () => {
    const listing = openListing({ status: 'cancelled' })

    await expect(requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null }))
      .rejects.toMatchObject({ code: 'listing_cancelled' })
  })

  it('refuses a table that has already started', async () => {
    const listing = openListing({ startsAt: new Date('2026-07-01T14:00:00Z') })

    await expect(requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null }))
      .rejects.toMatchObject({ code: 'listing_past' })
  })

  it('refuses the host a seat at their own table', async () => {
    const listing = openListing()

    await expect(requestSeat(deps(), { listingId: listing.id, userId: hostId, message: null }))
      .rejects.toMatchObject({ code: 'host_cannot_join_own_table' })
  })

  it('refuses a second request while one is still pending', async () => {
    const listing = openListing()
    await requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null })

    await expect(requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null }))
      .rejects.toMatchObject({ code: 'duplicate_seat_request' })
  })

  it('refuses a second request from someone already approved', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    await expect(requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null }))
      .rejects.toMatchObject({ code: 'duplicate_seat_request' })
  })

  it('lets someone ask again after being declined', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'declined' })

    const request = await requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null })

    expect(request.status).toBe('pending')
  })

  it('lets someone ask again after withdrawing', async () => {
    const listing = openListing()
    repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'withdrawn' })

    const request = await requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null })

    expect(request.status).toBe('pending')
  })

  it('refuses a table with every seat approved', async () => {
    const listing = openListing({ seatsOffered: 1 })
    repository.seedRequest({ tableId: listing.id, userId: otherId, status: 'approved' })

    await expect(requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null }))
      .rejects.toMatchObject({ code: 'table_full' })
  })

  it('allows more pending requests than there are seats', async () => {
    const listing = openListing({ seatsOffered: 1 })
    await requestSeat(deps(), { listingId: listing.id, userId: guestId, message: null })

    const second = await requestSeat(deps(), { listingId: listing.id, userId: otherId, message: null })

    expect(second.status).toBe('pending')
  })
})

describe('withdrawSeat', () => {
  it('withdraws a pending request', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'pending' })

    const updated = await withdrawSeat(deps(), { requestId: request.id, userId: guestId })

    expect(updated.status).toBe('withdrawn')
    expect(updated.decidedAt).toEqual(NOW)
    expect(updated.decidedBy).toBe(guestId)
  })

  it('withdraws an approved seat, freeing it for someone else', async () => {
    const listing = openListing({ seatsOffered: 1 })
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    await withdrawSeat(deps(), { requestId: request.id, userId: guestId })

    expect(await repository.countApprovedSeats(listing.id)).toBe(0)
  })

  it('refuses to let one guest withdraw another guest', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'pending' })

    await expect(withdrawSeat(deps(), { requestId: request.id, userId: otherId }))
      .rejects.toMatchObject({ code: 'not_seat_owner' })
  })

  it('refuses a request that does not exist', async () => {
    await expect(withdrawSeat(deps(), { requestId: 'nope', userId: guestId }))
      .rejects.toMatchObject({ code: 'seat_request_not_found' })
  })

  it('refuses a request that is already settled', async () => {
    const listing = openListing()
    for (const status of ['declined', 'withdrawn', 'removed'] as const) {
      const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status })

      await expect(
        withdrawSeat(deps(), { requestId: request.id, userId: guestId }),
        `expected withdrawing a ${status} request to be rejected`,
      ).rejects.toMatchObject({ code: 'seat_request_already_decided' })
    }
  })

  it('refuses to withdraw from a table that has already started', async () => {
    const listing = openListing({ startsAt: new Date('2026-07-01T14:00:00Z') })
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    await expect(withdrawSeat(deps(), { requestId: request.id, userId: guestId }))
      .rejects.toMatchObject({ code: 'listing_past' })
  })
})
```

Two of these encode product rules worth stating plainly. Declined and withdrawn people *may* ask again — the partial unique index only covers `pending` and `approved`, and a host who declined someone once because the table was nearly full should be able to change their mind. And pending requests may outnumber seats, because the host picks who joins; capping requests at the seat count would turn approval into a race between guests, which is exactly the dynamic hosting is meant to remove.

- [ ] **Step 4: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/seats/request-seat`.

- [ ] **Step 5: Implement**

Create `lib/domain/seats/request-seat.ts`:

```ts
import { DomainError } from '../errors'
import { deriveListingState } from '../tables/derive'
import type { SeatListing, SeatsDeps } from './ports'
import type { SeatRequest } from './types'

export const MAX_SEAT_MESSAGE_LENGTH = 280

export interface RequestSeatInput {
  listingId: string
  userId: string
  message: string | null
}

export interface WithdrawSeatInput {
  requestId: string
  userId: string
}

async function loadListing(deps: SeatsDeps, listingId: string): Promise<SeatListing> {
  const listing = await deps.repository.findListingForSeats(listingId)
  if (!listing) {
    throw new DomainError('listing_not_found', 'That table no longer exists.')
  }
  return listing
}

export async function requestSeat(deps: SeatsDeps, input: RequestSeatInput): Promise<SeatRequest> {
  const listing = await loadListing(deps, input.listingId)
  const approvedSeats = await deps.repository.countApprovedSeats(listing.id)
  const state = deriveListingState(listing, approvedSeats, deps.now())

  if (state.isCancelled) {
    throw new DomainError('listing_cancelled', 'That table was cancelled.')
  }
  if (state.isPast) {
    throw new DomainError('listing_past', 'That table has already started.')
  }
  if (input.userId === listing.hostId) {
    // Also a CHECK constraint in the database. Enforced here so the host gets a
    // sentence instead of a constraint violation.
    throw new DomainError('host_cannot_join_own_table', "It's your table — you're already there.")
  }

  const active = await deps.repository.findActiveRequest(listing.id, input.userId)
  if (active) {
    throw new DomainError(
      'duplicate_seat_request',
      active.status === 'approved' ? "You already have a seat at this table." : "You've already asked for a seat here.",
    )
  }

  if (state.isFull) {
    throw new DomainError('table_full', 'This table just filled up.')
  }

  const message = (input.message ?? '').trim()
  if (message.length > MAX_SEAT_MESSAGE_LENGTH) {
    throw new DomainError('invalid_input', `Keep your note under ${MAX_SEAT_MESSAGE_LENGTH} characters.`)
  }

  return deps.repository.insertRequest({
    tableId: listing.id,
    hostId: listing.hostId,
    userId: input.userId,
    message: message.length > 0 ? message : null,
  })
}

export async function withdrawSeat(deps: SeatsDeps, input: WithdrawSeatInput): Promise<SeatRequest> {
  const request = await deps.repository.findRequestById(input.requestId)
  if (!request) {
    throw new DomainError('seat_request_not_found', 'That request no longer exists.')
  }
  if (request.userId !== input.userId) {
    throw new DomainError('not_seat_owner', 'That seat is not yours to withdraw.')
  }
  if (request.status !== 'pending' && request.status !== 'approved') {
    throw new DomainError('seat_request_already_decided', 'That request is already settled.')
  }

  const listing = await loadListing(deps, request.tableId)
  if (deriveListingState(listing, 0, deps.now()).isPast) {
    throw new DomainError('listing_past', 'That table has already started.')
  }

  return deps.repository.setRequestStatus(request.id, 'withdrawn', deps.now(), input.userId)
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

Expected: all request-seat tests pass. The lint run matters here — `lib/domain/seats` is new, and this is the first chance for a stray framework import to appear in it.

- [ ] **Step 7: Commit and push**

```bash
git add lib/domain/seats tests/domain/seats
git commit -m "feat: add seat requests and withdrawal"
git push
```

---

### Task 7: Host decisions — approve, decline, remove

**Files:**
- Create: `lib/domain/seats/decide-seat.ts`
- Test: `tests/domain/seats/decide-seat.test.ts`

**Interfaces:**
- Consumes: `SeatsDeps`, `ApproveOutcome` (Task 6); `deriveListingState` (Task 3).
- Produces: `approveSeat(deps, input): Promise<SeatRequest>`; `declineSeat(deps, input): Promise<SeatRequest>`; `removeSeat(deps, input): Promise<SeatRequest>`; `interface DecideSeatInput { requestId, hostId }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/seats/decide-seat.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { approveSeat, declineSeat, removeSeat } from '@/lib/domain/seats/decide-seat'
import { FakePartyRepository } from '../../support/fake-party-repository'

const NOW = new Date('2026-08-01T12:00:00Z')
const LATER = new Date('2026-09-01T14:00:00Z')

let repository: FakePartyRepository
let hostId: string
let strangerId: string
let guestId: string

const deps = () => ({ repository, now: () => NOW })

beforeEach(() => {
  repository = new FakePartyRepository()
  hostId = repository.seedUser({ name: 'Host' }).id
  strangerId = repository.seedUser({ name: 'Stranger' }).id
  guestId = repository.seedUser({ name: 'Guest' }).id
})

const openListing = (overrides = {}) =>
  repository.seedListing({ hostId, startsAt: LATER, seatsOffered: 2, ...overrides })

describe('approveSeat', () => {
  it('approves a pending request and stamps who decided it, and when', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId })

    const approved = await approveSeat(deps(), { requestId: request.id, hostId })

    expect(approved.status).toBe('approved')
    expect(approved.decidedBy).toBe(hostId)
    expect(approved.decidedAt).toEqual(NOW)
  })

  it('refuses anyone who is not the host of that table', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId })

    await expect(approveSeat(deps(), { requestId: request.id, hostId: strangerId }))
      .rejects.toMatchObject({ code: 'not_listing_host' })
  })

  it('refuses a request that does not exist', async () => {
    await expect(approveSeat(deps(), { requestId: 'nope', hostId }))
      .rejects.toMatchObject({ code: 'seat_request_not_found' })
  })

  it('refuses a request that was already settled', async () => {
    const listing = openListing()
    for (const status of ['approved', 'declined', 'withdrawn', 'removed'] as const) {
      const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status })

      await expect(
        approveSeat(deps(), { requestId: request.id, hostId }),
        `expected approving a ${status} request to be rejected`,
      ).rejects.toMatchObject({ code: 'seat_request_already_decided' })
    }
  })

  it('refuses on a cancelled or already-started table', async () => {
    const cancelled = openListing({ status: 'cancelled' })
    const a = repository.seedRequest({ tableId: cancelled.id, userId: guestId })
    await expect(approveSeat(deps(), { requestId: a.id, hostId }))
      .rejects.toMatchObject({ code: 'listing_cancelled' })

    const past = openListing({ startsAt: new Date('2026-07-01T14:00:00Z') })
    const b = repository.seedRequest({ tableId: past.id, userId: guestId })
    await expect(approveSeat(deps(), { requestId: b.id, hostId }))
      .rejects.toMatchObject({ code: 'listing_past' })
  })

  it('reports a full table rather than overselling it', async () => {
    const listing = openListing({ seatsOffered: 1 })
    repository.seedRequest({ tableId: listing.id, userId: strangerId, status: 'approved' })
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId })

    await expect(approveSeat(deps(), { requestId: request.id, hostId }))
      .rejects.toMatchObject({ code: 'table_full' })
  })

  it('trusts the repository over its own count when the two disagree', async () => {
    // The repository is the only thing holding the lock. If it says the table
    // filled up between our read and our write, that is the truth.
    const listing = openListing({ seatsOffered: 4 })
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId })
    repository.forceApprovalFull = true

    await expect(approveSeat(deps(), { requestId: request.id, hostId }))
      .rejects.toMatchObject({ code: 'table_full' })
  })

  it('fills the last seat successfully', async () => {
    const listing = openListing({ seatsOffered: 2 })
    repository.seedRequest({ tableId: listing.id, userId: strangerId, status: 'approved' })
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId })

    const approved = await approveSeat(deps(), { requestId: request.id, hostId })

    expect(approved.status).toBe('approved')
    expect(await repository.countApprovedSeats(listing.id)).toBe(2)
  })
})

describe('declineSeat', () => {
  it('declines a pending request', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId })

    const declined = await declineSeat(deps(), { requestId: request.id, hostId })

    expect(declined.status).toBe('declined')
    expect(declined.decidedBy).toBe(hostId)
  })

  it('declines even when the table is full, because that is the useful case', async () => {
    const listing = openListing({ seatsOffered: 1 })
    repository.seedRequest({ tableId: listing.id, userId: strangerId, status: 'approved' })
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId })

    const declined = await declineSeat(deps(), { requestId: request.id, hostId })

    expect(declined.status).toBe('declined')
  })

  it('refuses anyone who is not the host', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId })

    await expect(declineSeat(deps(), { requestId: request.id, hostId: strangerId }))
      .rejects.toMatchObject({ code: 'not_listing_host' })
  })

  it('refuses a request that is not pending', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    await expect(declineSeat(deps(), { requestId: request.id, hostId }))
      .rejects.toMatchObject({ code: 'seat_request_already_decided' })
  })
})

describe('removeSeat', () => {
  it('removes an approved guest and frees their seat', async () => {
    const listing = openListing({ seatsOffered: 1 })
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    const removed = await removeSeat(deps(), { requestId: request.id, hostId })

    expect(removed.status).toBe('removed')
    expect(removed.decidedBy).toBe(hostId)
    expect(await repository.countApprovedSeats(listing.id)).toBe(0)
  })

  it('refuses to remove someone who is only pending — decline them instead', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'pending' })

    await expect(removeSeat(deps(), { requestId: request.id, hostId }))
      .rejects.toMatchObject({ code: 'seat_request_already_decided' })
  })

  it('refuses anyone who is not the host', async () => {
    const listing = openListing()
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    await expect(removeSeat(deps(), { requestId: request.id, hostId: strangerId }))
      .rejects.toMatchObject({ code: 'not_listing_host' })
  })

  it('refuses to remove anyone once the table has started', async () => {
    const listing = openListing({ startsAt: new Date('2026-07-01T14:00:00Z') })
    const request = repository.seedRequest({ tableId: listing.id, userId: guestId, status: 'approved' })

    await expect(removeSeat(deps(), { requestId: request.id, hostId }))
      .rejects.toMatchObject({ code: 'listing_past' })
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/seats/decide-seat`.

- [ ] **Step 3: Implement**

Create `lib/domain/seats/decide-seat.ts`:

```ts
import { DomainError } from '../errors'
import { deriveListingState } from '../tables/derive'
import type { SeatListing, SeatsDeps } from './ports'
import type { SeatRequest } from './types'

export interface DecideSeatInput {
  requestId: string
  hostId: string
}

/**
 * Load a request together with its listing, having verified the caller is the
 * host and the table is still live. Every host decision starts here.
 */
async function loadForDecision(
  deps: SeatsDeps, input: DecideSeatInput,
): Promise<{ request: SeatRequest; listing: SeatListing }> {
  const request = await deps.repository.findRequestById(input.requestId)
  if (!request) {
    throw new DomainError('seat_request_not_found', 'That request no longer exists.')
  }

  const listing = await deps.repository.findListingForSeats(request.tableId)
  if (!listing) {
    throw new DomainError('listing_not_found', 'That table no longer exists.')
  }
  if (listing.hostId !== input.hostId) {
    throw new DomainError('not_listing_host', 'Only the host can decide who joins this table.')
  }

  const state = deriveListingState(listing, 0, deps.now())
  if (state.isCancelled) {
    throw new DomainError('listing_cancelled', 'That table was cancelled.')
  }
  if (state.isPast) {
    throw new DomainError('listing_past', 'That table has already started.')
  }

  return { request, listing }
}

function assertPending(request: SeatRequest): void {
  if (request.status !== 'pending') {
    throw new DomainError('seat_request_already_decided', 'You already decided on this request.')
  }
}

export async function approveSeat(deps: SeatsDeps, input: DecideSeatInput): Promise<SeatRequest> {
  const { request } = await loadForDecision(deps, input)
  assertPending(request)

  // No seat count is taken here on purpose. The repository takes a row lock on
  // the listing and counts inside it; a count taken out here would be stale by
  // the time the write lands, which is the entire oversell bug.
  const outcome = await deps.repository.approveIfSeatAvailable(request.id, input.hostId, deps.now())

  if (!outcome.ok) {
    if (outcome.reason === 'table_full') {
      throw new DomainError('table_full', 'This table just filled up.')
    }
    throw new DomainError('seat_request_already_decided', 'You already decided on this request.')
  }

  return outcome.request
}

export async function declineSeat(deps: SeatsDeps, input: DecideSeatInput): Promise<SeatRequest> {
  const { request } = await loadForDecision(deps, input)
  assertPending(request)

  // Deliberately possible on a full table: declining the people who did not get
  // a seat is the main reason a host opens this screen at all.
  return deps.repository.setRequestStatus(request.id, 'declined', deps.now(), input.hostId)
}

export async function removeSeat(deps: SeatsDeps, input: DecideSeatInput): Promise<SeatRequest> {
  const { request } = await loadForDecision(deps, input)

  if (request.status !== 'approved') {
    throw new DomainError('seat_request_already_decided', "That person doesn't hold a seat at this table.")
  }

  return deps.repository.setRequestStatus(request.id, 'removed', deps.now(), input.hostId)
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

Expected: every domain test in the project passes — Plan 1's and Plan 2's together.

- [ ] **Step 5: Commit and push**

```bash
git add lib/domain/seats/decide-seat.ts tests/domain/seats/decide-seat.test.ts
git commit -m "feat: add host approve, decline, and remove decisions"
git push
```

---
