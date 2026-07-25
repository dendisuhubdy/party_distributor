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

### Task 8: PostgreSQL tables repository

**Files:**
- Create: `lib/db/repositories/tables.ts`
- Modify: `tests/support/db-helpers.ts`
- Test: `tests/integration/tables-repository.test.ts`

**Interfaces:**
- Consumes: `TablesRepository` and its types (Task 1); `db` and schema (Plan 1 Task 3).
- Produces: `class PostgresTablesRepository implements TablesRepository`, constructed as `new PostgresTablesRepository(db)`; `SUMMARY_COLUMNS` and `toSummary`, reused by the seats repository in Task 9.

- [ ] **Step 1: Extend the database test helpers**

Add to `tests/support/db-helpers.ts`:

```ts
import { seatRequests, tableListings, venues } from '@/lib/db/schema'
import type { SeatRequestStatus } from '@/lib/domain/seats/types'

export async function seedVenue(overrides: Partial<{ name: string; city: string }> = {}) {
  const [venue] = await db.insert(venues).values({
    name: overrides.name ?? `Venue ${crypto.randomUUID().slice(0, 8)}`,
    city: overrides.city ?? 'Bali',
  }).returning()
  return venue
}

export async function seedListing(input: {
  hostId: string
  venueId: string
  startsAt?: Date
  seatsOffered?: number
  seatPrice?: number
  status?: 'open' | 'cancelled'
}) {
  const [listing] = await db.insert(tableListings).values({
    hostId: input.hostId,
    venueId: input.venueId,
    startsAt: input.startsAt ?? new Date('2099-01-01T14:00:00Z'),
    seatsOffered: input.seatsOffered ?? 4,
    seatPrice: input.seatPrice ?? 2_500_000,
    status: input.status ?? 'open',
  }).returning()
  return listing
}

export async function seedRequest(input: {
  tableId: string
  hostId: string
  userId: string
  status?: SeatRequestStatus
}) {
  // hostId is required and must match the listing's host — the composite foreign
  // key `seat_requests_table_host_fk` rejects any other value.
  const [request] = await db.insert(seatRequests).values({
    tableId: input.tableId,
    hostId: input.hostId,
    userId: input.userId,
    status: input.status ?? 'pending',
  }).returning()
  return request
}
```

- [ ] **Step 2: Write the failing integration tests**

Create `tests/integration/tables-repository.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { seatRequests } from '@/lib/db/schema'
import { PostgresTablesRepository } from '@/lib/db/repositories/tables'
import { seedListing, seedRequest, seedUser, seedVenue, truncateAll } from '../support/db-helpers'

const repository = new PostgresTablesRepository(db)

let hostId: string
let guestId: string
let venueId: string

beforeEach(async () => {
  await truncateAll()
  hostId = (await seedUser({ email: 'host@example.com', name: 'Host' })).id
  guestId = (await seedUser({ email: 'guest@example.com', name: 'Guest' })).id
  venueId = (await seedVenue({ name: 'Savaya', city: 'Bali' })).id
})

describe('venues', () => {
  it('lists venues alphabetically', async () => {
    await seedVenue({ name: 'Atlas' })

    expect((await repository.listVenues()).map((v) => v.name)).toEqual(['Atlas', 'Savaya'])
  })

  it('matches a venue name case-insensitively so duplicates are not created', async () => {
    expect(await repository.findVenueByName('  savaya ')).toMatchObject({ id: venueId })
    expect(await repository.findVenueByName('Atlas')).toBeNull()
  })

  it('creates a venue attributed to the member who added it', async () => {
    const venue = await repository.createVenue({ name: 'Atlas', city: 'Bali', createdBy: hostId })

    expect(venue.name).toBe('Atlas')
    expect(await repository.findVenueById(venue.id)).toMatchObject({ name: 'Atlas' })
  })
})

describe('listings', () => {
  it('round-trips a listing including money and timestamps', async () => {
    const created = await repository.insertListing({
      hostId, venueId,
      eventName: 'Peggy Gou',
      startsAt: new Date('2099-08-15T14:00:00.000Z'),
      seatsOffered: 6,
      seatPrice: 2_500_000,
      tableTotal: 25_000_000,
      notes: 'Table 12',
      paymentLink: 'https://pay.example/x',
      paymentNote: 'GoPay',
    })

    const found = await repository.findListingById(created.id)

    expect(found).toMatchObject({
      hostId, venueId, eventName: 'Peggy Gou', seatsOffered: 6,
      seatPrice: 2_500_000, tableTotal: 25_000_000, status: 'open', cancelledAt: null,
    })
    expect(found!.startsAt).toEqual(new Date('2099-08-15T14:00:00.000Z'))
    expect(typeof found!.seatPrice).toBe('number')
  })

  it('stores a large table total without losing precision', async () => {
    // 25,000,000 IDR in sen would overflow int4. This is why the column is bigint
    // and the unit is the rupiah.
    const created = await repository.insertListing({
      hostId, venueId, eventName: null, startsAt: new Date('2099-01-01T14:00:00Z'),
      seatsOffered: 1, seatPrice: 9_007_199_254_740_991, tableTotal: null,
      notes: null, paymentLink: null, paymentNote: null,
    })

    expect((await repository.findListingById(created.id))!.seatPrice).toBe(9_007_199_254_740_991)
  })

  it('returns null for a listing that does not exist', async () => {
    expect(await repository.findListingById('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('summarises a listing with its venue, host, and approved count in one call', async () => {
    const listing = await seedListing({ hostId, venueId })
    await seedRequest({ tableId: listing.id, hostId, userId: guestId, status: 'approved' })

    const summary = await repository.findListingSummary(listing.id)

    expect(summary!.venue.name).toBe('Savaya')
    expect(summary!.host).toMatchObject({ id: hostId, name: 'Host' })
    expect(summary!.approvedSeats).toBe(1)
  })

  it('counts only approved requests toward the seat count', async () => {
    const listing = await seedListing({ hostId, venueId })
    for (const status of ['pending', 'declined', 'withdrawn', 'removed'] as const) {
      const user = await seedUser({ email: `${status}@example.com`, name: status })
      await seedRequest({ tableId: listing.id, hostId, userId: user.id, status })
    }

    expect(await repository.countApprovedSeats(listing.id)).toBe(0)
  })

  it('updates only the fields present in the patch', async () => {
    const listing = await seedListing({ hostId, venueId, seatsOffered: 4 })

    const updated = await repository.updateListing(listing.id, { notes: 'Table 12', seatsOffered: 6 })

    expect(updated.notes).toBe('Table 12')
    expect(updated.seatsOffered).toBe(6)
    expect(updated.seatPrice).toBe(listing.seatPrice)
  })

  it('clears a field set to null in the patch', async () => {
    const listing = await seedListing({ hostId, venueId })
    await repository.updateListing(listing.id, { notes: 'Something' })

    expect((await repository.updateListing(listing.id, { notes: null })).notes).toBeNull()
  })

  it('returns the listing unchanged when the patch is empty', async () => {
    const listing = await seedListing({ hostId, venueId })

    expect(await repository.updateListing(listing.id, {})).toMatchObject({ id: listing.id })
  })
})

describe('the feed query', () => {
  it('returns open upcoming listings soonest first', async () => {
    const later = await seedListing({ hostId, venueId, startsAt: new Date('2099-03-01T14:00:00Z') })
    const sooner = await seedListing({ hostId, venueId, startsAt: new Date('2099-02-01T14:00:00Z') })

    const feed = await repository.listUpcomingListings({ from: new Date('2026-01-01T00:00:00Z') })

    expect(feed.map((s) => s.listing.id)).toEqual([sooner.id, later.id])
  })

  it('excludes listings before the from bound', async () => {
    await seedListing({ hostId, venueId, startsAt: new Date('2099-02-01T14:00:00Z') })

    const feed = await repository.listUpcomingListings({ from: new Date('2099-06-01T00:00:00Z') })

    expect(feed).toHaveLength(0)
  })

  it('excludes listings at or after the to bound', async () => {
    await seedListing({ hostId, venueId, startsAt: new Date('2099-02-01T14:00:00Z') })

    const feed = await repository.listUpcomingListings({
      from: new Date('2026-01-01T00:00:00Z'), to: new Date('2099-02-01T14:00:00Z'),
    })

    expect(feed).toHaveLength(0)
  })

  it('excludes cancelled listings', async () => {
    await seedListing({ hostId, venueId, status: 'cancelled' })

    expect(await repository.listUpcomingListings({ from: new Date('2026-01-01T00:00:00Z') })).toHaveLength(0)
  })

  it('filters by venue', async () => {
    const other = await seedVenue({ name: 'Miss Fish' })
    await seedListing({ hostId, venueId })
    await seedListing({ hostId, venueId: other.id })

    const feed = await repository.listUpcomingListings({ from: new Date('2026-01-01T00:00:00Z'), venueId: other.id })

    expect(feed).toHaveLength(1)
    expect(feed[0].venue.name).toBe('Miss Fish')
  })

  it('lists what a member hosts, newest event first, including past and cancelled ones', async () => {
    const past = await seedListing({ hostId, venueId, startsAt: new Date('2020-01-01T14:00:00Z') })
    const future = await seedListing({ hostId, venueId, startsAt: new Date('2099-01-01T14:00:00Z') })
    await seedListing({ hostId: guestId, venueId })

    const hosted = await repository.listListingsHostedBy(hostId)

    expect(hosted.map((s) => s.listing.id)).toEqual([future.id, past.id])
  })
})

describe('cancelListing', () => {
  it('cancels the listing and settles every live request in one call', async () => {
    const listing = await seedListing({ hostId, venueId })
    const approvedUser = await seedUser({ email: 'approved@example.com', name: 'Approved' })
    const pendingUser = await seedUser({ email: 'pending@example.com', name: 'Pending' })
    const goneUser = await seedUser({ email: 'gone@example.com', name: 'Gone' })
    await seedRequest({ tableId: listing.id, hostId, userId: approvedUser.id, status: 'approved' })
    await seedRequest({ tableId: listing.id, hostId, userId: pendingUser.id, status: 'pending' })
    await seedRequest({ tableId: listing.id, hostId, userId: goneUser.id, status: 'withdrawn' })

    const at = new Date('2026-08-01T12:00:00.000Z')
    const result = await repository.cancelListing(listing.id, hostId, at)

    expect(result.listing.status).toBe('cancelled')
    expect(result.listing.cancelledAt).toEqual(at)
    expect(result.removedUserIds).toEqual([approvedUser.id])
    expect(result.declinedUserIds).toEqual([pendingUser.id])

    const rows = await db.select().from(seatRequests).where(eq(seatRequests.tableId, listing.id))
    const byUser = Object.fromEntries(rows.map((r) => [r.userId, r.status]))
    expect(byUser[approvedUser.id]).toBe('removed')
    expect(byUser[pendingUser.id]).toBe('declined')
    expect(byUser[goneUser.id]).toBe('withdrawn')
  })

  it('records who cancelled on every affected request', async () => {
    const listing = await seedListing({ hostId, venueId })
    await seedRequest({ tableId: listing.id, hostId, userId: guestId, status: 'approved' })

    await repository.cancelListing(listing.id, hostId, new Date('2026-08-01T12:00:00.000Z'))

    const [row] = await db.select().from(seatRequests).where(eq(seatRequests.tableId, listing.id))
    expect(row.decidedBy).toBe(hostId)
    expect(row.decidedAt).toEqual(new Date('2026-08-01T12:00:00.000Z'))
  })

  it('frees a person to request a seat again after cancellation', async () => {
    // The partial unique index only covers pending and approved. If the cascade
    // left a request in either state, this insert would violate it.
    const listing = await seedListing({ hostId, venueId })
    await seedRequest({ tableId: listing.id, hostId, userId: guestId, status: 'pending' })

    await repository.cancelListing(listing.id, hostId, new Date())

    await expect(seedRequest({ tableId: listing.id, hostId, userId: guestId, status: 'pending' }))
      .resolves.toMatchObject({ userId: guestId })
  })
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
npm run test:integration
```

Expected: failure resolving `@/lib/db/repositories/tables`.

- [ ] **Step 4: Implement the repository**

Create `lib/db/repositories/tables.ts`:

```ts
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { seatRequests, tableListings, users, venues } from '../schema'
import type {
  CancelCascade, FeedRange, ListingPatch, NewListing, TablesRepository,
} from '@/lib/domain/tables/ports'
import type { ListingSummary, TableListing, Venue } from '@/lib/domain/tables/types'

type ListingRow = typeof tableListings.$inferSelect
type VenueRow = typeof venues.$inferSelect

function toVenue(row: VenueRow): Venue {
  return { id: row.id, name: row.name, city: row.city }
}

function toListing(row: ListingRow): TableListing {
  return {
    id: row.id,
    hostId: row.hostId,
    venueId: row.venueId,
    eventName: row.eventName,
    startsAt: row.startsAt,
    seatsOffered: row.seatsOffered,
    seatPrice: row.seatPrice,
    tableTotal: row.tableTotal,
    notes: row.notes,
    paymentLink: row.paymentLink,
    paymentNote: row.paymentNote,
    status: row.status,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
  }
}

/**
 * A correlated subquery rather than a join with GROUP BY. It keeps every
 * summary query a plain row-per-listing select, which means no risk of a join
 * silently multiplying rows, and it stays correct when a listing has no
 * requests at all.
 */
const approvedSeatsSql = sql<number>`(
  select count(*) from ${seatRequests}
  where ${seatRequests.tableId} = ${tableListings.id}
    and ${seatRequests.status} = 'approved'
)`.mapWith(Number)

/** Shared so the seats repository can build the same summary shape in Task 9. */
export const SUMMARY_COLUMNS = {
  listing: tableListings,
  venue: venues,
  hostId: users.id,
  hostName: users.name,
  hostInstagram: users.instagramHandle,
  approvedSeats: approvedSeatsSql,
}

export interface SummaryRow {
  listing: ListingRow
  venue: VenueRow
  hostId: string
  hostName: string
  hostInstagram: string | null
  approvedSeats: number
}

export function toSummary(row: SummaryRow): ListingSummary {
  return {
    listing: toListing(row.listing),
    venue: toVenue(row.venue),
    host: { id: row.hostId, name: row.hostName, instagramHandle: row.hostInstagram },
    approvedSeats: row.approvedSeats,
  }
}

export class PostgresTablesRepository implements TablesRepository {
  constructor(private readonly db: Db) {}

  async listVenues(): Promise<Venue[]> {
    const rows = await this.db.select().from(venues).orderBy(asc(venues.name))
    return rows.map(toVenue)
  }

  async findVenueById(venueId: string): Promise<Venue | null> {
    const [row] = await this.db.select().from(venues).where(eq(venues.id, venueId)).limit(1)
    return row ? toVenue(row) : null
  }

  async findVenueByName(name: string): Promise<Venue | null> {
    const [row] = await this.db.select().from(venues)
      .where(eq(sql`lower(btrim(${venues.name}))`, name.trim().toLowerCase()))
      .limit(1)
    return row ? toVenue(row) : null
  }

  async createVenue(input: { name: string; city: string; createdBy: string }): Promise<Venue> {
    const [row] = await this.db.insert(venues).values(input).returning()
    return toVenue(row)
  }

  async insertListing(listing: NewListing): Promise<TableListing> {
    const [row] = await this.db.insert(tableListings).values(listing).returning()
    return toListing(row)
  }

  async findListingById(listingId: string): Promise<TableListing | null> {
    const [row] = await this.db.select().from(tableListings)
      .where(eq(tableListings.id, listingId)).limit(1)
    return row ? toListing(row) : null
  }

  async findListingSummary(listingId: string): Promise<ListingSummary | null> {
    const [row] = await this.db.select(SUMMARY_COLUMNS)
      .from(tableListings)
      .innerJoin(venues, eq(venues.id, tableListings.venueId))
      .innerJoin(users, eq(users.id, tableListings.hostId))
      .where(eq(tableListings.id, listingId))
      .limit(1)
    return row ? toSummary(row) : null
  }

  async listUpcomingListings(range: FeedRange): Promise<ListingSummary[]> {
    const conditions = [
      eq(tableListings.status, 'open'),
      gt(tableListings.startsAt, range.from),
    ]
    if (range.to) conditions.push(lt(tableListings.startsAt, range.to))
    if (range.venueId) conditions.push(eq(tableListings.venueId, range.venueId))

    const rows = await this.db.select(SUMMARY_COLUMNS)
      .from(tableListings)
      .innerJoin(venues, eq(venues.id, tableListings.venueId))
      .innerJoin(users, eq(users.id, tableListings.hostId))
      .where(and(...conditions))
      .orderBy(asc(tableListings.startsAt))

    return rows.map(toSummary)
  }

  async listListingsHostedBy(userId: string): Promise<ListingSummary[]> {
    const rows = await this.db.select(SUMMARY_COLUMNS)
      .from(tableListings)
      .innerJoin(venues, eq(venues.id, tableListings.venueId))
      .innerJoin(users, eq(users.id, tableListings.hostId))
      .where(eq(tableListings.hostId, userId))
      .orderBy(desc(tableListings.startsAt))

    return rows.map(toSummary)
  }

  async countApprovedSeats(listingId: string): Promise<number> {
    const [row] = await this.db.select({ approved: sql<number>`count(*)`.mapWith(Number) })
      .from(seatRequests)
      .where(and(eq(seatRequests.tableId, listingId), eq(seatRequests.status, 'approved')))
    return row?.approved ?? 0
  }

  async updateListing(listingId: string, patch: ListingPatch): Promise<TableListing> {
    // Drizzle rejects an empty SET clause, and an edit that changed nothing is a
    // normal outcome — the host may have resubmitted the form unchanged.
    const values = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    )
    if (Object.keys(values).length === 0) {
      const listing = await this.findListingById(listingId)
      if (!listing) throw new Error(`listing ${listingId} disappeared during update`)
      return listing
    }

    const [row] = await this.db.update(tableListings).set(values)
      .where(eq(tableListings.id, listingId)).returning()
    return toListing(row)
  }

  async cancelListing(listingId: string, byUserId: string, at: Date): Promise<CancelCascade> {
    return this.db.transaction(async (tx) => {
      const [listing] = await tx.update(tableListings)
        .set({ status: 'cancelled', cancelledAt: at })
        .where(eq(tableListings.id, listingId))
        .returning()

      const removed = await tx.update(seatRequests)
        .set({ status: 'removed', decidedAt: at, decidedBy: byUserId })
        .where(and(eq(seatRequests.tableId, listingId), eq(seatRequests.status, 'approved')))
        .returning({ userId: seatRequests.userId })

      // Pending requests are declined rather than left alone. A pending row
      // against a dead table would sit on the partial unique index forever,
      // blocking that person from asking again if the host relists.
      const declined = await tx.update(seatRequests)
        .set({ status: 'declined', decidedAt: at, decidedBy: byUserId })
        .where(and(eq(seatRequests.tableId, listingId), eq(seatRequests.status, 'pending')))
        .returning({ userId: seatRequests.userId })

      return {
        listing: toListing(listing),
        removedUserIds: removed.map((r) => r.userId),
        declinedUserIds: declined.map((r) => r.userId),
      }
    })
  }
}
```

- [ ] **Step 5: Run the integration tests**

```bash
npm run test:integration
```

Expected: every tables-repository test passes.

If the `seatPrice` round-trip returns a string rather than a number, the `bigint` column is missing `{ mode: 'number' }` in `lib/db/schema/table-listings.ts`. Fix it there, not with a cast here — a cast at the boundary would leave every other reader of that column wrong.

- [ ] **Step 6: Commit and push**

```bash
git add lib/db/repositories/tables.ts tests/integration/tables-repository.test.ts tests/support/db-helpers.ts
git commit -m "feat: add Postgres tables repository with cancellation cascade"
git push
```

---

### Task 9: PostgreSQL seats repository and the oversell guard

The load-bearing task of this plan. A host tapping approve on a phone and a laptop at the same moment must not put nine people at an eight-seat table.

**Files:**
- Create: `lib/db/repositories/seats.ts`
- Test: `tests/integration/seats-repository.test.ts`

**Interfaces:**
- Consumes: `SeatsRepository`, `ApproveOutcome` (Task 6); `SUMMARY_COLUMNS`, `toSummary` (Task 8); `db` and schema (Plan 1 Task 3).
- Produces: `class PostgresSeatsRepository implements SeatsRepository`, constructed as `new PostgresSeatsRepository(db)`.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/seats-repository.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { seatPayments, seatRequests } from '@/lib/db/schema'
import { PostgresSeatsRepository } from '@/lib/db/repositories/seats'
import { seedListing, seedRequest, seedUser, seedVenue, truncateAll } from '../support/db-helpers'

const repository = new PostgresSeatsRepository(db)

let hostId: string
let venueId: string

beforeEach(async () => {
  await truncateAll()
  hostId = (await seedUser({ email: 'host@example.com', name: 'Host' })).id
  venueId = (await seedVenue({ name: 'Savaya', city: 'Bali' })).id
})

const guest = (n: number) => seedUser({ email: `guest-${n}@example.com`, name: `Guest ${n}` })

describe('reads', () => {
  it('returns the slice of a listing that seat decisions need', async () => {
    const listing = await seedListing({ hostId, venueId, seatsOffered: 3, seatPrice: 2_500_000 })

    const found = await repository.findListingForSeats(listing.id)

    expect(found).toMatchObject({ id: listing.id, hostId, seatsOffered: 3, seatPrice: 2_500_000, status: 'open' })
    expect(found!.startsAt).toBeInstanceOf(Date)
  })

  it('returns null for a listing that does not exist', async () => {
    expect(await repository.findListingForSeats('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('finds a pending or approved request but ignores settled ones', async () => {
    const listing = await seedListing({ hostId, venueId })
    const a = await guest(1)
    const b = await guest(2)
    const c = await guest(3)
    await seedRequest({ tableId: listing.id, hostId, userId: a.id, status: 'pending' })
    await seedRequest({ tableId: listing.id, hostId, userId: b.id, status: 'approved' })
    await seedRequest({ tableId: listing.id, hostId, userId: c.id, status: 'declined' })

    expect(await repository.findActiveRequest(listing.id, a.id)).toMatchObject({ status: 'pending' })
    expect(await repository.findActiveRequest(listing.id, b.id)).toMatchObject({ status: 'approved' })
    expect(await repository.findActiveRequest(listing.id, c.id)).toBeNull()
  })

  it('inserts a request carrying the denormalized host id', async () => {
    const listing = await seedListing({ hostId, venueId })
    const a = await guest(1)

    const request = await repository.insertRequest({
      tableId: listing.id, hostId, userId: a.id, message: 'Bringing a friend',
    })

    expect(request).toMatchObject({ tableId: listing.id, hostId, userId: a.id, status: 'pending' })
    expect(request.message).toBe('Bringing a friend')
  })

  it('is rejected by the database if a host tries to take a seat at their own table', async () => {
    // Belt and braces: the domain refuses this, and so does the check constraint.
    const listing = await seedListing({ hostId, venueId })

    await expect(repository.insertRequest({
      tableId: listing.id, hostId, userId: hostId, message: null,
    })).rejects.toThrow()
  })

  it('is rejected by the database on a second active request from the same person', async () => {
    const listing = await seedListing({ hostId, venueId })
    const a = await guest(1)
    await repository.insertRequest({ tableId: listing.id, hostId, userId: a.id, message: null })

    await expect(repository.insertRequest({
      tableId: listing.id, hostId, userId: a.id, message: null,
    })).rejects.toThrow()
  })

  it('lists a roster oldest first with each guest attached', async () => {
    const listing = await seedListing({ hostId, venueId })
    const a = await guest(1)
    const b = await guest(2)
    await seedRequest({ tableId: listing.id, hostId, userId: a.id })
    await seedRequest({ tableId: listing.id, hostId, userId: b.id })

    const roster = await repository.listRequestsForListing(listing.id)

    expect(roster.map((entry) => entry.user.name)).toEqual(['Guest 1', 'Guest 2'])
  })

  it('lists the live seats a member holds with the full listing summary', async () => {
    const soon = await seedListing({ hostId, venueId, startsAt: new Date('2099-01-01T14:00:00Z') })
    const later = await seedListing({ hostId, venueId, startsAt: new Date('2099-06-01T14:00:00Z') })
    const settled = await seedListing({ hostId, venueId })
    const a = await guest(1)
    await seedRequest({ tableId: later.id, hostId, userId: a.id, status: 'approved' })
    await seedRequest({ tableId: soon.id, hostId, userId: a.id, status: 'pending' })
    await seedRequest({ tableId: settled.id, hostId, userId: a.id, status: 'declined' })

    const held = await repository.listSeatsHeldBy(a.id)

    expect(held.map((h) => h.listing.listing.id)).toEqual([soon.id, later.id])
    expect(held[0].listing.venue.name).toBe('Savaya')
    expect(held[0].listing.host.name).toBe('Host')
  })
})

describe('setRequestStatus', () => {
  it('records the new status with who set it and when', async () => {
    const listing = await seedListing({ hostId, venueId })
    const a = await guest(1)
    const request = await seedRequest({ tableId: listing.id, hostId, userId: a.id })
    const at = new Date('2026-08-01T12:00:00.000Z')

    const updated = await repository.setRequestStatus(request.id, 'declined', at, hostId)

    expect(updated).toMatchObject({ status: 'declined', decidedBy: hostId })
    expect(updated.decidedAt).toEqual(at)
  })
})

describe('approveIfSeatAvailable', () => {
  it('approves into a free seat and captures the price at that moment', async () => {
    const listing = await seedListing({ hostId, venueId, seatsOffered: 2, seatPrice: 2_500_000 })
    const a = await guest(1)
    const request = await seedRequest({ tableId: listing.id, hostId, userId: a.id })

    const outcome = await repository.approveIfSeatAvailable(request.id, hostId, new Date())

    expect(outcome.ok).toBe(true)

    const [payment] = await db.select().from(seatPayments).where(eq(seatPayments.seatRequestId, request.id))
    expect(payment.amount).toBe(2_500_000)
    expect(payment.markedPaidAt).toBeNull()
    expect(payment.confirmedAt).toBeNull()
  })

  it('reports a full table without changing anything', async () => {
    const listing = await seedListing({ hostId, venueId, seatsOffered: 1 })
    const taken = await guest(1)
    const waiting = await guest(2)
    await seedRequest({ tableId: listing.id, hostId, userId: taken.id, status: 'approved' })
    const request = await seedRequest({ tableId: listing.id, hostId, userId: waiting.id })

    const outcome = await repository.approveIfSeatAvailable(request.id, hostId, new Date())

    expect(outcome).toEqual({ ok: false, reason: 'table_full' })

    const [row] = await db.select().from(seatRequests).where(eq(seatRequests.id, request.id))
    expect(row.status).toBe('pending')
  })

  it('reports a request that is no longer pending', async () => {
    const listing = await seedListing({ hostId, venueId })
    const a = await guest(1)
    const request = await seedRequest({ tableId: listing.id, hostId, userId: a.id, status: 'declined' })

    expect(await repository.approveIfSeatAvailable(request.id, hostId, new Date()))
      .toEqual({ ok: false, reason: 'already_decided' })
  })

  it('lets a withdrawn seat be filled by someone else', async () => {
    const listing = await seedListing({ hostId, venueId, seatsOffered: 1 })
    const gone = await guest(1)
    const next = await guest(2)
    await seedRequest({ tableId: listing.id, hostId, userId: gone.id, status: 'withdrawn' })
    const request = await seedRequest({ tableId: listing.id, hostId, userId: next.id })

    expect((await repository.approveIfSeatAvailable(request.id, hostId, new Date())).ok).toBe(true)
  })

  it('lets exactly one of four simultaneous approvals into the last seat', async () => {
    const listing = await seedListing({ hostId, venueId, seatsOffered: 1 })
    const requests = []
    for (let i = 1; i <= 4; i++) {
      const g = await guest(i)
      requests.push(await seedRequest({ tableId: listing.id, hostId, userId: g.id }))
    }

    const outcomes = await Promise.all(
      requests.map((request) => repository.approveIfSeatAvailable(request.id, hostId, new Date())),
    )

    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
    expect(outcomes.filter((o) => !o.ok && o.reason === 'table_full')).toHaveLength(3)

    const approved = await db.select().from(seatRequests).where(eq(seatRequests.status, 'approved'))
    expect(approved).toHaveLength(1)

    // And exactly one payment row, because the insert lives inside the same
    // transaction as the approval.
    expect(await db.select().from(seatPayments)).toHaveLength(1)
  })

  it('fills every seat and no more when approvals arrive together', async () => {
    const listing = await seedListing({ hostId, venueId, seatsOffered: 3 })
    const requests = []
    for (let i = 1; i <= 8; i++) {
      const g = await guest(i)
      requests.push(await seedRequest({ tableId: listing.id, hostId, userId: g.id }))
    }

    const outcomes = await Promise.all(
      requests.map((request) => repository.approveIfSeatAvailable(request.id, hostId, new Date())),
    )

    expect(outcomes.filter((o) => o.ok)).toHaveLength(3)

    const approved = await db.select().from(seatRequests).where(eq(seatRequests.status, 'approved'))
    expect(approved).toHaveLength(3)
  })
})
```

The last two tests are why this task is separate from every other. Everything else here could be verified by reading the code; these cannot.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm run test:integration
```

Expected: failure resolving `@/lib/db/repositories/seats`.

- [ ] **Step 3: Implement**

Create `lib/db/repositories/seats.ts`:

```ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { seatPayments, seatRequests, tableListings, users, venues } from '../schema'
import { SUMMARY_COLUMNS, toSummary } from './tables'
import type {
  ApproveOutcome, NewSeatRequest, SeatListing, SeatsRepository,
} from '@/lib/domain/seats/ports'
import type { HeldSeat, RosterEntry, SeatRequest, SeatRequestStatus } from '@/lib/domain/seats/types'

type SeatRequestRow = typeof seatRequests.$inferSelect

function toSeatRequest(row: SeatRequestRow): SeatRequest {
  return {
    id: row.id,
    tableId: row.tableId,
    hostId: row.hostId,
    userId: row.userId,
    message: row.message,
    status: row.status,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt,
  }
}

const ACTIVE: SeatRequestStatus[] = ['pending', 'approved']

export class PostgresSeatsRepository implements SeatsRepository {
  constructor(private readonly db: Db) {}

  async findListingForSeats(listingId: string): Promise<SeatListing | null> {
    const [row] = await this.db.select({
      id: tableListings.id,
      hostId: tableListings.hostId,
      startsAt: tableListings.startsAt,
      seatsOffered: tableListings.seatsOffered,
      seatPrice: tableListings.seatPrice,
      status: tableListings.status,
    }).from(tableListings).where(eq(tableListings.id, listingId)).limit(1)

    return row ?? null
  }

  async findActiveRequest(listingId: string, userId: string): Promise<SeatRequest | null> {
    const [row] = await this.db.select().from(seatRequests)
      .where(and(
        eq(seatRequests.tableId, listingId),
        eq(seatRequests.userId, userId),
        inArray(seatRequests.status, ACTIVE),
      ))
      .limit(1)

    return row ? toSeatRequest(row) : null
  }

  async countApprovedSeats(listingId: string): Promise<number> {
    const [row] = await this.db.select({ approved: sql<number>`count(*)`.mapWith(Number) })
      .from(seatRequests)
      .where(and(eq(seatRequests.tableId, listingId), eq(seatRequests.status, 'approved')))
    return row?.approved ?? 0
  }

  async insertRequest(input: NewSeatRequest): Promise<SeatRequest> {
    const [row] = await this.db.insert(seatRequests).values(input).returning()
    return toSeatRequest(row)
  }

  async findRequestById(requestId: string): Promise<SeatRequest | null> {
    const [row] = await this.db.select().from(seatRequests)
      .where(eq(seatRequests.id, requestId)).limit(1)
    return row ? toSeatRequest(row) : null
  }

  async listRequestsForListing(listingId: string): Promise<RosterEntry[]> {
    const rows = await this.db.select({
      request: seatRequests,
      userId: users.id,
      userName: users.name,
      userInstagram: users.instagramHandle,
    })
      .from(seatRequests)
      .innerJoin(users, eq(users.id, seatRequests.userId))
      .where(eq(seatRequests.tableId, listingId))
      .orderBy(asc(seatRequests.createdAt))

    return rows.map((row) => ({
      request: toSeatRequest(row.request),
      user: { id: row.userId, name: row.userName, instagramHandle: row.userInstagram },
    }))
  }

  async listSeatsHeldBy(userId: string): Promise<HeldSeat[]> {
    const rows = await this.db.select({ ...SUMMARY_COLUMNS, request: seatRequests })
      .from(seatRequests)
      .innerJoin(tableListings, eq(tableListings.id, seatRequests.tableId))
      .innerJoin(venues, eq(venues.id, tableListings.venueId))
      .innerJoin(users, eq(users.id, tableListings.hostId))
      .where(and(eq(seatRequests.userId, userId), inArray(seatRequests.status, ACTIVE)))
      .orderBy(asc(tableListings.startsAt))

    return rows.map((row) => ({ request: toSeatRequest(row.request), listing: toSummary(row) }))
  }

  /**
   * The oversell guard.
   *
   * `SELECT ... FOR UPDATE` on the listing row serialises every concurrent
   * approval for that table. The seat count is taken *after* the lock is held,
   * so it cannot be stale: any competing approval either has not started
   * counting yet, or has already committed and is visible to this statement's
   * fresh READ COMMITTED snapshot.
   *
   * Locking the listing rather than the request rows is deliberate. The
   * contended resource is the table's capacity, and only a row every approval
   * for that table must touch can protect it. Locking the request would let two
   * different requests race into the same last seat.
   */
  async approveIfSeatAvailable(requestId: string, decidedBy: string, at: Date): Promise<ApproveOutcome> {
    return this.db.transaction(async (tx) => {
      const [request] = await tx.select().from(seatRequests)
        .where(eq(seatRequests.id, requestId)).limit(1)

      if (!request || request.status !== 'pending') {
        return { ok: false, reason: 'already_decided' }
      }

      const [listing] = await tx.select({
        seatsOffered: tableListings.seatsOffered,
        seatPrice: tableListings.seatPrice,
      })
        .from(tableListings)
        .where(eq(tableListings.id, request.tableId))
        .for('update')
        .limit(1)

      if (!listing) return { ok: false, reason: 'already_decided' }

      const [counted] = await tx.select({ approved: sql<number>`count(*)`.mapWith(Number) })
        .from(seatRequests)
        .where(and(eq(seatRequests.tableId, request.tableId), eq(seatRequests.status, 'approved')))

      if (counted.approved >= listing.seatsOffered) {
        return { ok: false, reason: 'table_full' }
      }

      // The status predicate makes this a compare-and-set as well as an update,
      // so a request decided since the read above cannot be approved twice.
      const [updated] = await tx.update(seatRequests)
        .set({ status: 'approved', decidedAt: at, decidedBy })
        .where(and(eq(seatRequests.id, requestId), eq(seatRequests.status, 'pending')))
        .returning()

      if (!updated) return { ok: false, reason: 'already_decided' }

      // The price is captured here, at approval, rather than read from the
      // listing whenever the roster is rendered. It keeps every settled seat
      // correct even if a future version relaxes the price freeze.
      await tx.insert(seatPayments)
        .values({ seatRequestId: updated.id, amount: listing.seatPrice })
        .onConflictDoNothing()

      return { ok: true, request: toSeatRequest(updated) }
    })
  }

  async setRequestStatus(
    requestId: string, status: SeatRequestStatus, at: Date, decidedBy: string,
  ): Promise<SeatRequest> {
    const [row] = await this.db.update(seatRequests)
      .set({ status, decidedAt: at, decidedBy })
      .where(eq(seatRequests.id, requestId))
      .returning()
    return toSeatRequest(row)
  }
}
```

- [ ] **Step 4: Run the integration tests**

```bash
npm run test:integration
```

Expected: every seats-repository test passes, including both concurrency tests.

- [ ] **Step 5: Prove the concurrency tests can actually fail**

A concurrency test that passes against unguarded code proves nothing. Delete one line — the `.for('update')` — from `approveIfSeatAvailable`:

```ts
        .from(tableListings)
        .where(eq(tableListings.id, request.tableId))
        .limit(1)
```

```bash
npm run test:integration
```

Expected: "lets exactly one of four simultaneous approvals into the last seat" FAILS, reporting more than one winner, and the eight-into-three test overfills as well. **Restore `.for('update')`** and re-run to confirm both pass again.

If the tests still pass without the lock, the four approvals are not actually running concurrently — check that `lib/db/client.ts` sets `max: 10` on the postgres client. With a pool of one, every transaction serialises by accident and the test is measuring nothing.

- [ ] **Step 6: Commit and push**

```bash
git add lib/db/repositories/seats.ts tests/integration/seats-repository.test.ts
git commit -m "feat: add Postgres seats repository with row-locked oversell guard"
git push
```

---

### Task 10: Wiring, navigation, and the feed

The first screen of this plan. From here the tasks are adapters: authenticate, call a domain function, render.

**Files:**
- Create: `lib/tables-service.ts`, `lib/seats-service.ts`, `lib/session.ts`
- Create: `app/nav.tsx`, `app/listing-card.tsx`
- Modify: `app/layout.tsx`, `app/page.tsx`

**Interfaces:**
- Consumes: every domain module so far; `auth`, `signOut` (Plan 1 Task 7).
- Produces: `tablesDeps`, `seatsDeps`, the single wired `TablesDeps`/`SeatsDeps` every adapter uses; `requireUserId(): Promise<string>`; `<Nav />`; `<ListingCard summary now />`.

- [ ] **Step 1: Wire the domain to the database**

Create `lib/tables-service.ts`:

```ts
import { db } from '@/lib/db/client'
import { PostgresTablesRepository } from '@/lib/db/repositories/tables'
import type { TablesDeps } from '@/lib/domain/tables/ports'

export const tablesDeps: TablesDeps = {
  repository: new PostgresTablesRepository(db),
  now: () => new Date(),
}
```

Create `lib/seats-service.ts`:

```ts
import { db } from '@/lib/db/client'
import { PostgresSeatsRepository } from '@/lib/db/repositories/seats'
import type { SeatsDeps } from '@/lib/domain/seats/ports'

export const seatsDeps: SeatsDeps = {
  repository: new PostgresSeatsRepository(db),
  now: () => new Date(),
}
```

These two files and `lib/membership-service.ts` are the only places the domain meets the database.

- [ ] **Step 2: Add the session guard**

Plan 1 repeated the guard inline because there were four routes. This plan adds seven more, so it becomes a function.

Create `lib/session.ts`:

```ts
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'

/**
 * The route guard, used by pages and server actions alike.
 *
 * Deliberately not middleware. `auth()` here is bound to a Drizzle adapter over
 * postgres.js, which opens TCP sockets and cannot run in the Edge runtime that
 * Next.js middleware uses. See Plan 1 Task 7 Step 2.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')
  return session.user.id
}
```

- [ ] **Step 3: Build the navigation**

Create `app/nav.tsx`:

```tsx
import Link from 'next/link'
import { auth, signOut } from '@/lib/auth'

const linkClass = 'text-sm text-neutral-600 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-50'

export async function Nav() {
  const session = await auth()
  if (!session?.user?.id) return null

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <nav className="mx-auto flex max-w-lg items-center gap-4 px-6 py-3">
        <Link href="/" className="mr-auto font-semibold">Party</Link>
        <Link href="/tables/new" className={linkClass}>List a table</Link>
        <Link href="/me" className={linkClass}>Me</Link>
        <Link href="/invites" className={linkClass}>Invites</Link>
        <form
          action={async () => {
            'use server'
            await signOut({ redirectTo: '/login' })
          }}
        >
          <button type="submit" className={linkClass}>Sign out</button>
        </form>
      </nav>
    </header>
  )
}
```

- [ ] **Step 4: Mount the navigation in the layout**

In `app/layout.tsx`, import `Nav` and render it immediately inside `<body>`, before `{children}`:

```tsx
import { Nav } from './nav'
```

```tsx
      <body className={...}>
        <Nav />
        {children}
      </body>
```

`Nav` renders nothing when signed out, so `/login` and `/join` are unaffected.

- [ ] **Step 5: Build the listing card**

Create `app/listing-card.tsx`:

```tsx
import Link from 'next/link'
import { formatEventTime } from '@/lib/domain/event-time'
import { formatRupiah } from '@/lib/domain/money'
import { deriveSummaryState } from '@/lib/domain/tables/derive'
import type { ListingSummary } from '@/lib/domain/tables/types'

export function ListingCard({ summary, now }: { summary: ListingSummary; now: Date }) {
  const { listing, venue, host } = summary
  const state = deriveSummaryState(summary, now)

  const badge = state.isCancelled
    ? { text: 'Cancelled', tone: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400' }
    : state.isPast
      ? { text: 'Past', tone: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400' }
      : state.isFull
        ? { text: 'Full', tone: 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900' }
        : { text: `${state.spotsLeft} left`, tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' }

  return (
    <Link
      href={`/tables/${listing.id}`}
      className="block rounded-xl border border-neutral-200 p-4 active:bg-neutral-50 dark:border-neutral-800 dark:active:bg-neutral-900"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{venue.name}</p>
          {listing.eventName && (
            <p className="truncate text-sm text-neutral-500">{listing.eventName}</p>
          )}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${badge.tone}`}>
          {badge.text}
        </span>
      </div>

      <p className="mt-3 text-sm">{formatEventTime(listing.startsAt)}</p>
      <p className="mt-1 text-sm text-neutral-500">
        {formatRupiah(listing.seatPrice)} per seat · hosted by {host.name}
      </p>
    </Link>
  )
}
```

Every time on every screen goes through `formatEventTime`, which pins the zone to Bali. A raw `toLocaleString()` anywhere would render the server's timezone instead.

- [ ] **Step 6: Build the feed**

Replace `app/page.tsx`:

```tsx
import Link from 'next/link'
import { isDomainError } from '@/lib/domain/errors'
import { listFeed } from '@/lib/domain/tables/list-feed'
import type { ListingSummary } from '@/lib/domain/tables/types'
import { requireUserId } from '@/lib/session'
import { tablesDeps } from '@/lib/tables-service'
import { ListingCard } from './listing-card'

const fieldClass =
  'rounded-lg border border-neutral-300 px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-950'

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ venue?: string; from?: string; to?: string }>
}) {
  await requireUserId()
  const { venue, from, to } = await searchParams

  const venues = await tablesDeps.repository.listVenues()

  let feed: ListingSummary[] = []
  let error: string | null = null
  try {
    feed = await listFeed(tablesDeps, { venueId: venue, fromDay: from, toDay: to })
  } catch (caught) {
    if (!isDomainError(caught)) throw caught
    error = caught.message
  }

  const now = new Date()

  return (
    <main className="mx-auto max-w-lg px-6 py-8">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">Tables</h1>
        <Link href="/tables/new" className="text-sm underline">List one</Link>
      </div>

      {/* A plain GET form: filters survive a refresh, are shareable as a URL,
          and need no client JavaScript. */}
      <form className="mt-4 flex flex-wrap gap-2" method="get">
        <select name="venue" defaultValue={venue ?? ''} className={fieldClass}>
          <option value="">Any venue</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
        <input type="date" name="from" defaultValue={from ?? ''} className={fieldClass} aria-label="From" />
        <input type="date" name="to" defaultValue={to ?? ''} className={fieldClass} aria-label="To" />
        <button type="submit" className={`${fieldClass} font-medium`}>Filter</button>
      </form>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <ul className="mt-6 flex flex-col gap-3">
        {feed.map((summary) => (
          <li key={summary.listing.id}>
            <ListingCard summary={summary} now={now} />
          </li>
        ))}
      </ul>

      {feed.length === 0 && !error && (
        <div className="mt-6 rounded-xl bg-neutral-100 p-6 text-center dark:bg-neutral-900">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            No tables coming up.
          </p>
          <Link href="/tables/new" className="mt-2 inline-block text-sm underline">
            List the first one
          </Link>
        </div>
      )}
    </main>
  )
}
```

- [ ] **Step 7: Verify manually**

```bash
docker compose up -d
npm run dev
```

Sign in as the seeded founder (use the token escape hatch from Plan 1 Task 7 Step 5). Expect the nav bar, an empty feed with the "list the first one" prompt, and a venue dropdown holding Savaya and Miss Fish.

Insert a listing directly so the feed has something in it:

```bash
docker compose exec -T db psql -U party -d party -c "
  insert into table_listings (host_id, venue_id, starts_at, seats_offered, seat_price)
  select u.id, v.id, now() + interval '10 days', 4, 2500000
  from users u, venues v where v.name = 'Savaya' limit 1"
```

Expect one card showing "Savaya", the Bali-time start, "Rp 2.500.000 per seat", and a green "4 left" badge.

- [ ] **Step 8: Confirm the production build passes**

```bash
npm run build
```

Expected: success.

- [ ] **Step 9: Commit and push**

```bash
git add lib/tables-service.ts lib/seats-service.ts lib/session.ts app/nav.tsx app/listing-card.tsx app/layout.tsx app/page.tsx
git commit -m "feat: add the tables feed with venue and date filters"
git push
```

---

### Task 11: Listing a table

**Files:**
- Create: `app/tables/new/page.tsx`, `app/tables/new/form.tsx`, `app/tables/new/actions.ts`

**Interfaces:**
- Consumes: `createListing` (Task 4), `findOrCreateVenue` (Task 1), `parseBaliDateTime` (Task 2), `parseRupiah` (Plan 1 Task 2), `tablesDeps` and `requireUserId` (Task 10).
- Produces: `createListingAction(prev, formData)`; `interface NewListingState { error?: string }`.

- [ ] **Step 1: Write the server action**

Create `app/tables/new/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isDomainError } from '@/lib/domain/errors'
import { parseBaliDateTime } from '@/lib/domain/event-time'
import { parseRupiah } from '@/lib/domain/money'
import { createListing } from '@/lib/domain/tables/create-listing'
import { findOrCreateVenue } from '@/lib/domain/tables/venues'
import { requireUserId } from '@/lib/session'
import { tablesDeps } from '@/lib/tables-service'

export interface NewListingState {
  error?: string
}

/** The sentinel the venue select uses for "somewhere not on the list". */
export const NEW_VENUE = '__new__'

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '')
}

function optionalText(formData: FormData, key: string): string | null {
  const value = text(formData, key).trim()
  return value.length > 0 ? value : null
}

async function resolveVenueId(formData: FormData, userId: string): Promise<string> {
  const chosen = text(formData, 'venueId')
  if (chosen !== NEW_VENUE) return chosen

  const venue = await findOrCreateVenue(tablesDeps, {
    name: text(formData, 'venueName'),
    city: text(formData, 'venueCity'),
    createdBy: userId,
  })
  return venue.id
}

export async function createListingAction(
  _prev: NewListingState,
  formData: FormData,
): Promise<NewListingState> {
  const userId = await requireUserId()

  let listingId: string
  try {
    const venueId = await resolveVenueId(formData, userId)
    const tableTotalRaw = optionalText(formData, 'tableTotal')

    const listing = await createListing(tablesDeps, {
      hostId: userId,
      venueId,
      eventName: optionalText(formData, 'eventName'),
      startsAt: parseBaliDateTime(text(formData, 'startsAt')),
      // An empty seat count becomes 0, which createListing rejects with a
      // sentence about offering between 1 and 20 seats. That is the message we
      // want, so no separate check is needed here.
      seatsOffered: Number(text(formData, 'seatsOffered')),
      seatPrice: parseRupiah(text(formData, 'seatPrice')),
      tableTotal: tableTotalRaw === null ? null : parseRupiah(tableTotalRaw),
      notes: optionalText(formData, 'notes'),
      paymentLink: optionalText(formData, 'paymentLink'),
      paymentNote: optionalText(formData, 'paymentNote'),
    })
    listingId = listing.id
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  revalidatePath('/')
  // Outside the try: redirect signals by throwing, and catching that would show
  // the host a failure after their table was successfully created.
  redirect(`/tables/${listingId}`)
}
```

- [ ] **Step 2: Build the form**

Create `app/tables/new/form.tsx`:

```tsx
'use client'

import { useActionState, useState } from 'react'
import type { Venue } from '@/lib/domain/tables/types'
import { NEW_VENUE, createListingAction, type NewListingState } from './actions'

const inputClass =
  'w-full rounded-lg border border-neutral-300 px-4 py-3 text-base dark:border-neutral-700 dark:bg-neutral-950'
const labelClass = 'text-sm font-medium'

export function NewListingForm({ venues }: { venues: Venue[] }) {
  const [state, formAction, pending] = useActionState<NewListingState, FormData>(createListingAction, {})
  const [venueId, setVenueId] = useState(venues[0]?.id ?? NEW_VENUE)

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Venue</span>
        <select
          name="venueId" value={venueId} onChange={(event) => setVenueId(event.target.value)}
          className={inputClass}
        >
          {venues.map((venue) => (
            <option key={venue.id} value={venue.id}>{venue.name}</option>
          ))}
          <option value={NEW_VENUE}>Somewhere else…</option>
        </select>
      </label>

      {venueId === NEW_VENUE && (
        <div className="flex gap-2">
          <input name="venueName" placeholder="Venue name" className={inputClass} />
          <input name="venueCity" defaultValue="Bali" placeholder="City" className={inputClass} />
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Starts</span>
        <input type="datetime-local" name="startsAt" required className={inputClass} />
        <span className="text-xs text-neutral-500">Bali time (WITA).</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Seats for guests</span>
        <input
          type="number" name="seatsOffered" required min={1} max={20} defaultValue={4}
          inputMode="numeric" className={inputClass}
        />
        <span className="text-xs text-neutral-500">Your own place is not one of these.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Price per seat</span>
        <input
          name="seatPrice" required inputMode="numeric" placeholder="2.500.000" className={inputClass}
        />
        <span className="text-xs text-neutral-500">Rupiah. Everyone pays the same.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Event name (optional)</span>
        <input name="eventName" placeholder="Peggy Gou" className={inputClass} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Table total (optional)</span>
        <input name="tableTotal" inputMode="numeric" placeholder="25.000.000" className={inputClass} />
        <span className="text-xs text-neutral-500">Shown on the listing so people can see your math. Nothing is calculated from it.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Payment link (optional)</span>
        <input name="paymentLink" inputMode="url" placeholder="https://…" className={inputClass} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>How to pay (optional)</span>
        <input name="paymentNote" placeholder="GoPay to 0812…" className={inputClass} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Notes (optional)</span>
        <textarea name="notes" rows={3} placeholder="Table 12, arrive before midnight" className={inputClass} />
      </label>

      {state.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}

      <button
        type="submit" disabled={pending}
        className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? 'Listing…' : 'List the table'}
      </button>
    </form>
  )
}
```

Every input is `text-base`, which is 16px. Below that, iOS Safari zooms the viewport on focus — disorienting on a phone at 1am, which is exactly when this form gets used.

- [ ] **Step 3: Build the page**

Create `app/tables/new/page.tsx`:

```tsx
import { requireUserId } from '@/lib/session'
import { tablesDeps } from '@/lib/tables-service'
import { NewListingForm } from './form'

export default async function NewListingPage() {
  await requireUserId()
  const venues = await tablesDeps.repository.listVenues()

  return (
    <main className="mx-auto max-w-lg px-6 py-8">
      <h1 className="text-2xl font-semibold">List a table</h1>
      <p className="mt-2 text-sm text-neutral-500">
        You&apos;ve booked it. Offer the spare seats at a fixed price and approve who joins.
      </p>

      <NewListingForm venues={venues} />
    </main>
  )
}
```

- [ ] **Step 4: Verify manually, including the timezone**

```bash
npm run dev
```

List a table at Savaya starting at 22:00 on a date ten days out. Expect a redirect to the detail page (404 until Task 12 — that is fine), and:

```bash
docker compose exec -T db psql -U party -d party -c \
  "select starts_at, starts_at at time zone 'Asia/Makassar' as bali, seat_price from table_listings order by created_at desc limit 1"
```

Expected: the `bali` column reads 22:00 on the date you chose. If it reads 22:00 in the `starts_at` column instead, `parseBaliDateTime` is being bypassed somewhere.

Then try the failure paths: a price of `abc`, zero seats, a `paymentLink` of `ftp://x`, and a start time in the past. Each should re-render the form with a specific sentence, not a stack trace.

- [ ] **Step 5: Confirm the production build passes**

```bash
npm run build
```

- [ ] **Step 6: Commit and push**

```bash
git add app/tables/new
git commit -m "feat: add the list-a-table screen"
git push
```

---

### Task 12: Listing detail and requesting a seat

**Files:**
- Create: `app/tables/[id]/page.tsx`, `app/tables/[id]/seat-forms.tsx`, `app/tables/[id]/actions.ts`

**Interfaces:**
- Consumes: `requestSeat`, `withdrawSeat` (Task 6); `deriveSummaryState` (Task 3); `seatsDeps`, `tablesDeps`, `requireUserId` (Task 10).
- Produces: `requestSeatAction(prev, formData)`, `withdrawSeatAction(prev, formData)`; `interface SeatActionState { error?: string }`.

- [ ] **Step 1: Write the server actions**

Create `app/tables/[id]/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { isDomainError } from '@/lib/domain/errors'
import { requestSeat, withdrawSeat } from '@/lib/domain/seats/request-seat'
import { seatsDeps } from '@/lib/seats-service'
import { requireUserId } from '@/lib/session'

export interface SeatActionState {
  error?: string
}

function revalidateListing(listingId: string): void {
  revalidatePath(`/tables/${listingId}`)
  revalidatePath(`/tables/${listingId}/manage`)
  // The feed shows spots-left, and /me shows the seats this person holds.
  revalidatePath('/')
  revalidatePath('/me')
}

export async function requestSeatAction(
  _prev: SeatActionState,
  formData: FormData,
): Promise<SeatActionState> {
  const userId = await requireUserId()
  const listingId = String(formData.get('listingId') ?? '')

  try {
    await requestSeat(seatsDeps, {
      listingId,
      userId,
      message: String(formData.get('message') ?? '') || null,
    })
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  revalidateListing(listingId)
  return {}
}

export async function withdrawSeatAction(
  _prev: SeatActionState,
  formData: FormData,
): Promise<SeatActionState> {
  const userId = await requireUserId()
  const listingId = String(formData.get('listingId') ?? '')

  try {
    await withdrawSeat(seatsDeps, { requestId: String(formData.get('requestId') ?? ''), userId })
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  revalidateListing(listingId)
  return {}
}
```

- [ ] **Step 2: Build the guest-facing forms**

Create `app/tables/[id]/seat-forms.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { requestSeatAction, withdrawSeatAction, type SeatActionState } from './actions'

const primaryClass =
  'w-full rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900'
const secondaryClass =
  'w-full rounded-lg border border-neutral-300 px-4 py-3 text-base disabled:opacity-50 dark:border-neutral-700'

function ErrorMessage({ state }: { state: SeatActionState }) {
  if (!state.error) return null
  return (
    <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
      {state.error}
    </p>
  )
}

export function RequestSeatForm({ listingId }: { listingId: string }) {
  const [state, formAction, pending] = useActionState<SeatActionState, FormData>(requestSeatAction, {})

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="listingId" value={listingId} />
      <textarea
        name="message" rows={2} maxLength={280}
        placeholder="Anything the host should know? (optional)"
        className="w-full rounded-lg border border-neutral-300 px-4 py-3 text-base dark:border-neutral-700 dark:bg-neutral-950"
      />
      <ErrorMessage state={state} />
      <button type="submit" disabled={pending} className={primaryClass}>
        {pending ? 'Asking…' : 'Ask for a seat'}
      </button>
    </form>
  )
}

export function WithdrawSeatForm({ listingId, requestId }: { listingId: string; requestId: string }) {
  const [state, formAction, pending] = useActionState<SeatActionState, FormData>(withdrawSeatAction, {})

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="requestId" value={requestId} />
      <ErrorMessage state={state} />
      <button type="submit" disabled={pending} className={secondaryClass}>
        {pending ? 'Withdrawing…' : 'Withdraw'}
      </button>
    </form>
  )
}
```

- [ ] **Step 3: Build the detail page**

Create `app/tables/[id]/page.tsx`:

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { formatEventTime } from '@/lib/domain/event-time'
import { formatRupiah } from '@/lib/domain/money'
import { deriveSummaryState } from '@/lib/domain/tables/derive'
import { seatsDeps } from '@/lib/seats-service'
import { requireUserId } from '@/lib/session'
import { tablesDeps } from '@/lib/tables-service'
import { RequestSeatForm, WithdrawSeatForm } from './seat-forms'

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId()
  const { id } = await params

  const summary = await tablesDeps.repository.findListingSummary(id)
  if (!summary) notFound()

  const { listing, venue, host } = summary
  const state = deriveSummaryState(summary, new Date())
  const roster = await seatsDeps.repository.listRequestsForListing(listing.id)

  const approved = roster.filter((entry) => entry.request.status === 'approved')
  const mine = roster.find(
    (entry) => entry.request.userId === userId
      && (entry.request.status === 'pending' || entry.request.status === 'approved'),
  )
  const isHost = listing.hostId === userId

  return (
    <main className="mx-auto max-w-lg px-6 py-8">
      <h1 className="text-2xl font-semibold">{venue.name}</h1>
      {listing.eventName && <p className="mt-1 text-neutral-500">{listing.eventName}</p>}

      <dl className="mt-6 flex flex-col gap-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-neutral-500">When</dt>
          <dd>{formatEventTime(listing.startsAt)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-neutral-500">Per seat</dt>
          <dd className="font-medium">{formatRupiah(listing.seatPrice)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-neutral-500">Spots</dt>
          <dd>
            {state.isFull ? 'Full' : `${state.spotsLeft} of ${listing.seatsOffered} left`}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-neutral-500">Host</dt>
          <dd>
            {host.name}
            {host.instagramHandle && <span className="text-neutral-500"> · {host.instagramHandle}</span>}
          </dd>
        </div>
        {listing.tableTotal !== null && (
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">Table total</dt>
            <dd className="text-neutral-500">{formatRupiah(listing.tableTotal)}</dd>
          </div>
        )}
      </dl>

      {listing.notes && (
        <p className="mt-6 whitespace-pre-wrap rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          {listing.notes}
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-neutral-500">
          At the table ({approved.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {approved.map((entry) => (
            <li key={entry.request.id}>
              {entry.user.name}
              {entry.user.instagramHandle && (
                <span className="text-neutral-500"> · {entry.user.instagramHandle}</span>
              )}
            </li>
          ))}
          {approved.length === 0 && <li className="text-neutral-500">Nobody yet.</li>}
        </ul>
      </section>

      <section className="mt-8">
        {isHost ? (
          <Link
            href={`/tables/${listing.id}/manage`}
            className="block rounded-lg border border-neutral-300 px-4 py-3 text-center text-base dark:border-neutral-700"
          >
            Manage this table
          </Link>
        ) : state.isCancelled ? (
          <p className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
            This table was cancelled.
          </p>
        ) : state.isPast ? (
          <p className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
            This table has already happened.
          </p>
        ) : mine?.request.status === 'approved' ? (
          <div className="flex flex-col gap-3">
            <p className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
              You&apos;re in. {formatRupiah(listing.seatPrice)} to {host.name}.
              {listing.paymentNote && <> {listing.paymentNote}</>}
            </p>
            {listing.paymentLink && (
              <a
                href={listing.paymentLink}
                rel="noopener noreferrer nofollow"
                target="_blank"
                className="block rounded-lg bg-neutral-900 px-4 py-3 text-center text-base font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                Pay the host
              </a>
            )}
            <WithdrawSeatForm listingId={listing.id} requestId={mine.request.id} />
          </div>
        ) : mine?.request.status === 'pending' ? (
          <div className="flex flex-col gap-3">
            <p className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
              You&apos;ve asked for a seat. {host.name} will decide.
            </p>
            <WithdrawSeatForm listingId={listing.id} requestId={mine.request.id} />
          </div>
        ) : state.isFull ? (
          <p className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
            This table is full.
          </p>
        ) : (
          <RequestSeatForm listingId={listing.id} />
        )}
      </section>
    </main>
  )
}
```

The payment link carries `rel="noopener noreferrer nofollow"` and opens in a new tab. It is a URL one member typed and every other member clicks; the app should not lend it the referrer or any window handle.

- [ ] **Step 4: Verify manually**

Seed a second member and sign in as them using the token escape hatch from Plan 1 Task 7 Step 5.

1. Open the table listed in Task 11 → expect the details, an empty roster, and "Ask for a seat".
2. Ask for a seat → expect "You've asked for a seat" and a Withdraw button.
3. Ask again by reloading and resubmitting → the form is gone, so this is not reachable; confirm the guard anyway by re-running `npm test` for the duplicate case.
4. Withdraw → the request form returns.
5. As the host, open the same page → expect "Manage this table" instead of a request form.

- [ ] **Step 5: Confirm the production build passes**

```bash
npm run build
```

- [ ] **Step 6: Commit and push**

```bash
git add "app/tables/[id]/page.tsx" "app/tables/[id]/seat-forms.tsx" "app/tables/[id]/actions.ts"
git commit -m "feat: add listing detail with seat requests and withdrawal"
git push
```

---

### Task 13: The host's manage view

**Files:**
- Create: `app/tables/[id]/manage/page.tsx`, `app/tables/[id]/manage/decision-buttons.tsx`, `app/tables/[id]/manage/edit-form.tsx`, `app/tables/[id]/manage/actions.ts`

**Interfaces:**
- Consumes: `approveSeat`, `declineSeat`, `removeSeat` (Task 7); `editListing`, `cancelListing` (Task 5); `toBaliDateTimeValue` (Task 2).
- Produces: `decideAction(prev, formData)`, `editListingAction(prev, formData)`, `cancelListingAction(prev, formData)`; `interface ManageState { error?: string }`.

- [ ] **Step 1: Write the server actions**

Create `app/tables/[id]/manage/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isDomainError } from '@/lib/domain/errors'
import { parseBaliDateTime } from '@/lib/domain/event-time'
import { parseRupiah } from '@/lib/domain/money'
import { approveSeat, declineSeat, removeSeat } from '@/lib/domain/seats/decide-seat'
import { cancelListing, editListing } from '@/lib/domain/tables/manage-listing'
import { seatsDeps } from '@/lib/seats-service'
import { requireUserId } from '@/lib/session'
import { tablesDeps } from '@/lib/tables-service'

export interface ManageState {
  error?: string
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '')
}

function revalidateListing(listingId: string): void {
  revalidatePath(`/tables/${listingId}`)
  revalidatePath(`/tables/${listingId}/manage`)
  revalidatePath('/')
  revalidatePath('/me')
}

export async function decideAction(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const hostId = await requireUserId()
  const listingId = text(formData, 'listingId')
  const requestId = text(formData, 'requestId')
  // The value of whichever submit button was pressed. Browsers include the
  // activated button's name/value in the payload and no other button's.
  const decision = text(formData, 'decision')

  try {
    if (decision === 'approve') await approveSeat(seatsDeps, { requestId, hostId })
    else if (decision === 'decline') await declineSeat(seatsDeps, { requestId, hostId })
    else if (decision === 'remove') await removeSeat(seatsDeps, { requestId, hostId })
    else return { error: 'Unknown action.' }
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  revalidateListing(listingId)
  return {}
}

export async function editListingAction(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const hostId = await requireUserId()
  const listingId = text(formData, 'listingId')

  try {
    // Every field is sent on every submit. editListing compares each against the
    // stored value, so resubmitting a frozen price or time unchanged is fine —
    // only an actual change to a frozen field is rejected.
    await editListing(tablesDeps, {
      listingId,
      hostId,
      patch: {
        eventName: text(formData, 'eventName'),
        notes: text(formData, 'notes'),
        paymentLink: text(formData, 'paymentLink'),
        paymentNote: text(formData, 'paymentNote'),
        seatsOffered: Number(text(formData, 'seatsOffered')),
        seatPrice: parseRupiah(text(formData, 'seatPrice')),
        startsAt: parseBaliDateTime(text(formData, 'startsAt')),
      },
    })
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  revalidateListing(listingId)
  return {}
}

export async function cancelListingAction(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const hostId = await requireUserId()
  const listingId = text(formData, 'listingId')

  try {
    await cancelListing(tablesDeps, { listingId, hostId })
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  revalidateListing(listingId)
  // Outside the try: redirect signals by throwing.
  redirect(`/tables/${listingId}`)
}
```

- [ ] **Step 2: Build the decision buttons**

Create `app/tables/[id]/manage/decision-buttons.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { decideAction, type ManageState } from './actions'

const buttonClass = 'rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50'

export function DecisionButtons({
  listingId, requestId, actions,
}: {
  listingId: string
  requestId: string
  actions: Array<'approve' | 'decline' | 'remove'>
}) {
  const [state, formAction, pending] = useActionState<ManageState, FormData>(decideAction, {})

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="requestId" value={requestId} />

      <div className="flex gap-2">
        {actions.includes('approve') && (
          <button
            type="submit" name="decision" value="approve" disabled={pending}
            className={`${buttonClass} bg-neutral-900 text-white dark:bg-white dark:text-neutral-900`}
          >
            Approve
          </button>
        )}
        {actions.includes('decline') && (
          <button
            type="submit" name="decision" value="decline" disabled={pending}
            className={`${buttonClass} border border-neutral-300 dark:border-neutral-700`}
          >
            Decline
          </button>
        )}
        {actions.includes('remove') && (
          <button
            type="submit" name="decision" value="remove" disabled={pending}
            className={`${buttonClass} border border-neutral-300 dark:border-neutral-700`}
          >
            Remove
          </button>
        )}
      </div>

      {state.error && (
        <p role="alert" className="text-right text-sm text-red-700 dark:text-red-300">{state.error}</p>
      )}
    </form>
  )
}
```

Two submit buttons in one form, distinguished by `name="decision"`, is what keeps a single action handling all three decisions. The alternative — one form per button — would need three actions and three pending states for a row that can only be in one of them at a time.

- [ ] **Step 3: Build the edit and cancel forms**

Create `app/tables/[id]/manage/edit-form.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { cancelListingAction, editListingAction, type ManageState } from './actions'

const inputClass =
  'w-full rounded-lg border border-neutral-300 px-4 py-3 text-base read-only:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:read-only:bg-neutral-900'
const labelClass = 'text-sm font-medium'

export function EditListingForm({
  listingId, defaults, locked,
}: {
  listingId: string
  defaults: {
    eventName: string
    notes: string
    paymentLink: string
    paymentNote: string
    seatsOffered: number
    seatPrice: string
    startsAt: string
  }
  /** True once anyone has been approved: price and time are frozen. */
  locked: boolean
}) {
  const [state, formAction, pending] = useActionState<ManageState, FormData>(editListingAction, {})

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="listingId" value={listingId} />

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Starts</span>
        <input
          type="datetime-local" name="startsAt" defaultValue={defaults.startsAt}
          readOnly={locked} className={inputClass}
        />
        <span className="text-xs text-neutral-500">
          Bali time (WITA).{locked && ' Locked — someone has already been approved.'}
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Price per seat</span>
        <input name="seatPrice" defaultValue={defaults.seatPrice} readOnly={locked} className={inputClass} />
        {locked && <span className="text-xs text-neutral-500">Locked. Cancel and relist to change it.</span>}
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Seats for guests</span>
        <input
          type="number" name="seatsOffered" min={1} max={20}
          defaultValue={defaults.seatsOffered} inputMode="numeric" className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Event name</span>
        <input name="eventName" defaultValue={defaults.eventName} className={inputClass} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Payment link</span>
        <input name="paymentLink" defaultValue={defaults.paymentLink} inputMode="url" className={inputClass} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>How to pay</span>
        <input name="paymentNote" defaultValue={defaults.paymentNote} className={inputClass} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Notes</span>
        <textarea name="notes" rows={3} defaultValue={defaults.notes} className={inputClass} />
      </label>

      {state.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}

      <button
        type="submit" disabled={pending}
        className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  )
}

export function CancelListingForm({ listingId }: { listingId: string }) {
  const [state, formAction, pending] = useActionState<ManageState, FormData>(cancelListingAction, {})

  return (
    <details className="rounded-lg border border-red-200 p-4 dark:border-red-900">
      <summary className="cursor-pointer text-sm font-medium text-red-700 dark:text-red-300">
        Cancel this table
      </summary>
      <p className="mt-3 text-sm text-neutral-500">
        Everyone who has a seat loses it and will need refunding by you directly. This cannot be undone.
      </p>
      <form action={formAction} className="mt-3">
        <input type="hidden" name="listingId" value={listingId} />
        {state.error && (
          <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-300">{state.error}</p>
        )}
        <button
          type="submit" disabled={pending}
          className="w-full rounded-lg bg-red-600 px-4 py-3 text-base font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Cancelling…' : 'Yes, cancel the table'}
        </button>
      </form>
    </details>
  )
}
```

The confirmation is a `<details>` disclosure rather than a `confirm()` dialog. A native dialog blocks the page and is awkward to reach on a phone; a disclosure makes the destructive button take two deliberate taps and stays inspectable.

- [ ] **Step 4: Build the manage page**

Create `app/tables/[id]/manage/page.tsx`:

```tsx
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { formatEventTime, toBaliDateTimeValue } from '@/lib/domain/event-time'
import { formatRupiah } from '@/lib/domain/money'
import { deriveSummaryState } from '@/lib/domain/tables/derive'
import { seatsDeps } from '@/lib/seats-service'
import { requireUserId } from '@/lib/session'
import { tablesDeps } from '@/lib/tables-service'
import { DecisionButtons } from './decision-buttons'
import { CancelListingForm, EditListingForm } from './edit-form'

export default async function ManageListingPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId()
  const { id } = await params

  const summary = await tablesDeps.repository.findListingSummary(id)
  if (!summary) notFound()

  // A non-host has no business here. Redirect rather than 403: the page they
  // actually wanted exists and they are allowed to see it.
  if (summary.listing.hostId !== userId) redirect(`/tables/${id}`)

  const { listing } = summary
  const state = deriveSummaryState(summary, new Date())
  const roster = await seatsDeps.repository.listRequestsForListing(listing.id)

  const pending = roster.filter((entry) => entry.request.status === 'pending')
  const approved = roster.filter((entry) => entry.request.status === 'approved')
  const settled = roster.filter(
    (entry) => entry.request.status === 'declined'
      || entry.request.status === 'withdrawn'
      || entry.request.status === 'removed',
  )

  const editable = !state.isCancelled && !state.isPast

  return (
    <main className="mx-auto max-w-lg px-6 py-8">
      <Link href={`/tables/${listing.id}`} className="text-sm underline">← Back to the table</Link>

      <h1 className="mt-4 text-2xl font-semibold">Manage</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {summary.venue.name} · {formatEventTime(listing.startsAt)} · {formatRupiah(listing.seatPrice)} per seat
      </p>

      {state.isCancelled && (
        <p className="mt-4 rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          This table is cancelled.
        </p>
      )}
      {!state.isCancelled && state.isPast && (
        <p className="mt-4 rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          This table has already happened.
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-neutral-500">
          Waiting on you ({pending.length}) · {state.spotsLeft} of {listing.seatsOffered} spots left
        </h2>
        <ul className="mt-2 flex flex-col gap-3">
          {pending.map((entry) => (
            <li key={entry.request.id} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
              <p className="font-medium">{entry.user.name}</p>
              {entry.user.instagramHandle && (
                <p className="text-xs text-neutral-500">{entry.user.instagramHandle}</p>
              )}
              {entry.request.message && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-400">
                  {entry.request.message}
                </p>
              )}
              {editable && (
                <div className="mt-3">
                  <DecisionButtons
                    listingId={listing.id}
                    requestId={entry.request.id}
                    actions={['approve', 'decline']}
                  />
                </div>
              )}
            </li>
          ))}
          {pending.length === 0 && <li className="text-sm text-neutral-500">Nothing pending.</li>}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-neutral-500">At the table ({approved.length})</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {approved.map((entry) => (
            <li
              key={entry.request.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{entry.user.name}</p>
                {entry.user.instagramHandle && (
                  <p className="truncate text-xs text-neutral-500">{entry.user.instagramHandle}</p>
                )}
              </div>
              {editable && (
                <DecisionButtons listingId={listing.id} requestId={entry.request.id} actions={['remove']} />
              )}
            </li>
          ))}
          {approved.length === 0 && <li className="text-sm text-neutral-500">Nobody yet.</li>}
        </ul>
      </section>

      {settled.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-500">Earlier</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-neutral-500">
            {settled.map((entry) => (
              <li key={entry.request.id}>{entry.user.name} — {entry.request.status}</li>
            ))}
          </ul>
        </section>
      )}

      {editable && (
        <>
          <section className="mt-10">
            <h2 className="text-sm font-medium text-neutral-500">Edit</h2>
            <div className="mt-2">
              <EditListingForm
                listingId={listing.id}
                locked={approved.length > 0}
                defaults={{
                  eventName: listing.eventName ?? '',
                  notes: listing.notes ?? '',
                  paymentLink: listing.paymentLink ?? '',
                  paymentNote: listing.paymentNote ?? '',
                  seatsOffered: listing.seatsOffered,
                  seatPrice: String(listing.seatPrice),
                  startsAt: toBaliDateTimeValue(listing.startsAt),
                }}
              />
            </div>
          </section>

          <section className="mt-10">
            <CancelListingForm listingId={listing.id} />
          </section>
        </>
      )}
    </main>
  )
}
```

- [ ] **Step 5: Verify manually, including the oversell guard from the UI**

```bash
npm run dev
```

With one host, a table offering 1 seat, and two members who have both asked:

1. Approve the first → they move to "At the table", spots left goes to 0.
2. Approve the second → expect "This table just filled up." in red under the buttons, and the request stays pending.
3. Remove the first → the second can now be approved.
4. Try to change the price while someone is approved → the field is read-only; change it with dev tools and submit → expect "You cannot change the price once someone has been approved."
5. Raise seats from 1 to 2 while someone is approved → expect success.
6. Cancel the table → expect a redirect to the detail page showing "This table was cancelled", and every approved guest moved to `removed`:

```bash
docker compose exec -T db psql -U party -d party -c \
  "select status, count(*) from seat_requests group by status"
```

- [ ] **Step 6: Confirm the production build passes**

```bash
npm run build
```

- [ ] **Step 7: Commit and push**

```bash
git add "app/tables/[id]/manage"
git commit -m "feat: add the host manage view with approvals, edits, and cancellation"
git push
```

---
