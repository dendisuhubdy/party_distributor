# Settlement & Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host see at a glance who has paid without the app ever touching money, and tell everyone what happened by email so nobody has to open the app to find out.

**Architecture:** Unchanged. Payment state lives in `lib/domain/settlement/**` and email in `lib/domain/notify/**`, both plain TypeScript behind ports. `notify` is the one module that imports none of the others — it receives payloads. Email dispatch always happens *after* the database transaction commits, in the server action, and a failure to send never rolls back the thing that happened.

**Tech Stack:** Next.js 15, TypeScript, PostgreSQL 16, Drizzle ORM, Auth.js v5, Resend, Tailwind CSS, Vitest, Playwright, Docker Compose. One new dev dependency: `@playwright/test`.

This plan is #3 of 3. Plan 1 delivered invite → account → sign in. Plan 2 delivered list → find → request → approve. This plan delivers pay → confirm → and tells everyone.

**Depends on:** Plans 1 and 2, fully executed.
**Source spec:** `docs/superpowers/specs/2026-07-25-party-table-splitting-design.md`

## Global Constraints

Every task's requirements implicitly include this section, carried over unchanged from Plans 1 and 2.

- **`lib/domain/**` must not import from `next`, `react`, `next-auth`, `drizzle-orm`, or `@/lib/db`.** The ESLint rule fails the build on violation.
- **No `Date.now()` or `new Date()` inside `lib/domain/**`.** Time enters through an injected `now: () => Date`.
- **Money is whole rupiah as `number`, persisted as `bigint`.** Format only through `formatRupiah`.
- **Every event time is rendered through `formatEventTime`,** which pins the zone to `Asia/Makassar`. This applies to email bodies too — an email is the one place a wrong timezone is unrecoverable, because the reader cannot refresh it.
- **Every database identifier is `snake_case`; every TypeScript identifier is `camelCase`.**
- **TDD is mandatory.** Write the failing test, watch it fail for the right reason, then implement.
- **Commit and push after every task.**

## The two rules that shape this plan

**The app never holds money.** There is no payment processor, no escrow, no refund engine. A host attaches their own link or QR; the app records two claims — the guest's "I paid" and the host's "I received it" — and shows where they disagree. Every state in this plan is a *claim about* a payment, never a payment.

That is also why "refund owed" is a flag and not a workflow. When a guest withdraws after paying, the app surfaces it on the host's grid and stops. Pretending to enforce something the platform cannot enforce would be worse than showing the gap honestly.

**Email is best-effort and idempotent.** Dispatch happens after the transaction commits, never inside it — a Resend outage must not roll back a seat approval. Every send is claimed against `email_log`'s `unique(kind, entity_id, to_user_id)` constraint first, so a retry cannot double-send.

## The schema already exists

Plan 1 Task 3 created `seat_payments` and `email_log` with their constraints, and Plan 2 Task 9 already inserts a `seat_payments` row inside the approval transaction, carrying the price captured at that moment. **This plan writes no migrations.** It reads and updates rows that are already there.

```
seat_payments   seat_request_id (pk), amount, marked_paid_at,
                confirmed_at, confirmed_by, method, note

email_log       id, kind, entity_id, to_user_id, sent_at
                unique(kind, entity_id, to_user_id)
```

## File structure

```
lib/
├─ domain/
│  ├─ event-time.ts                   + baliDayBounds (Task 9)
│  ├─ settlement/
│  │  ├─ types.ts                     SeatPayment, PaymentState, PaymentRow
│  │  ├─ derive.ts                    derivePaymentState, buildPaymentGrid
│  │  ├─ ports.ts                     SettlementRepository, SettlementDeps
│  │  └─ record-payment.ts            markSeatPaid, confirmSeatPayment
│  └─ notify/
│     ├─ types.ts                     EmailKind, EmailMessage, digests
│     ├─ ports.ts                     EmailSender, EmailLogRepository, NotifyDeps
│     ├─ templates.ts                 One pure function per email
│     └─ dispatch.ts                  claim → send → release-on-failure
├─ db/repositories/
│  ├─ settlement.ts                   PostgresSettlementRepository
│  └─ email-log.ts                    PostgresEmailLogRepository
├─ email/resend-sender.ts             ResendEmailSender
├─ settlement-service.ts              settlementDeps
├─ notify-service.ts                  notifyDeps
└─ notifications.ts                   The adapter that loads data and dispatches

app/
├─ api/cron/reminders/route.ts        Day-before reminders, shared-secret guarded
├─ tables/[id]/
│  ├─ seat-forms.tsx                  + MarkPaidForm
│  ├─ actions.ts                      + markPaidAction
│  └─ manage/
│     ├─ page.tsx                     + the payment grid
│     ├─ payment-grid.tsx             Host confirm controls
│     └─ actions.ts                   + confirmPaymentAction
└─ me/page.tsx                        Real payment status per seat

e2e/                                  Playwright, four paths
playwright.config.ts
```

---

### Task 1: Payment state

Four states derived from two timestamps and the seat's status. Pure, and the whole of the settlement model.

**Files:**
- Modify: `lib/domain/errors.ts`
- Create: `lib/domain/settlement/types.ts`, `lib/domain/settlement/derive.ts`
- Test: `tests/domain/settlement/derive.test.ts`

**Interfaces:**
- Consumes: `Rupiah` (Plan 1), `SeatRequest`/`SeatRequestStatus` (Plan 2 Task 6).
- Produces: `type PaymentState = 'unpaid' | 'marked_paid' | 'confirmed' | 'refund_owed'`; `interface SeatPayment`; `interface SeatPaymentEntry`; `interface PaymentRow`; `derivePaymentState(payment, requestStatus): PaymentState`; `buildPaymentGrid(entries): PaymentRow[]`; `totalOutstanding(rows): Rupiah`.

- [ ] **Step 1: Add the error codes this plan needs**

In `lib/domain/errors.ts`, add a settlement group before `// shared`:

```ts
  // settlement (Plan 3)
  | 'seat_payment_not_found'
  | 'seat_not_approved'
```

There is deliberately no `payment_already_confirmed`. Marking or confirming twice is not an error — it is the same person tapping the same button twice on a slow connection, and both use cases are written to be idempotent instead.

- [ ] **Step 2: Define the settlement types**

Create `lib/domain/settlement/types.ts`:

```ts
import type { Rupiah } from '../money'
import type { SeatRequest } from '../seats/types'

/**
 * What the app knows about one seat's money. Every value here is a *claim*:
 * the platform never holds funds and cannot verify any of them.
 */
export interface SeatPayment {
  seatRequestId: string
  /** Captured when the seat was approved, not read from the listing later. */
  amount: Rupiah
  /** The guest said they paid. */
  markedPaidAt: Date | null
  /** The host said they received it. */
  confirmedAt: Date | null
  confirmedBy: string | null
  method: string | null
  note: string | null
}

export type PaymentState =
  /** Nobody has claimed anything. */
  | 'unpaid'
  /** The guest says they paid; the host has not confirmed. */
  | 'marked_paid'
  /** The host confirmed receiving it. */
  | 'confirmed'
  /** Money was claimed or confirmed, and the seat is gone. The host owes it back. */
  | 'refund_owed'

/** One row as the repository returns it, before state is derived. */
export interface SeatPaymentEntry {
  request: SeatRequest
  user: { id: string; name: string; instagramHandle: string | null }
  payment: SeatPayment
}

export interface PaymentRow extends SeatPaymentEntry {
  state: PaymentState
}
```

- [ ] **Step 3: Write the failing tests**

Create `tests/domain/settlement/derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildPaymentGrid, derivePaymentState, totalOutstanding } from '@/lib/domain/settlement/derive'
import type { SeatPayment, SeatPaymentEntry } from '@/lib/domain/settlement/types'
import type { SeatRequest, SeatRequestStatus } from '@/lib/domain/seats/types'

const AT = new Date('2026-08-01T12:00:00Z')

const payment = (overrides: Partial<SeatPayment> = {}): SeatPayment => ({
  seatRequestId: 'request-1',
  amount: 2_500_000,
  markedPaidAt: null,
  confirmedAt: null,
  confirmedBy: null,
  method: null,
  note: null,
  ...overrides,
})

describe('derivePaymentState', () => {
  it('is unpaid when nobody has claimed anything', () => {
    expect(derivePaymentState(payment(), 'approved')).toBe('unpaid')
  })

  it('is marked_paid on the guest\'s claim alone', () => {
    expect(derivePaymentState(payment({ markedPaidAt: AT }), 'approved')).toBe('marked_paid')
  })

  it('is confirmed once the host says it arrived', () => {
    expect(derivePaymentState(payment({ markedPaidAt: AT, confirmedAt: AT }), 'approved')).toBe('confirmed')
  })

  it('is confirmed even if the host confirmed without the guest marking', () => {
    // A host who watched the transfer land has no reason to wait for the guest.
    expect(derivePaymentState(payment({ confirmedAt: AT }), 'approved')).toBe('confirmed')
  })

  it('flags a refund when a confirmed payer leaves the table', () => {
    for (const status of ['withdrawn', 'removed'] as const) {
      expect(
        derivePaymentState(payment({ markedPaidAt: AT, confirmedAt: AT }), status),
        `expected ${status} to owe a refund`,
      ).toBe('refund_owed')
    }
  })

  it('flags a refund on an unconfirmed claim too, so the host checks', () => {
    expect(derivePaymentState(payment({ markedPaidAt: AT }), 'withdrawn')).toBe('refund_owed')
  })

  it('owes nothing when someone leaves without ever claiming payment', () => {
    expect(derivePaymentState(payment(), 'withdrawn')).toBe('unpaid')
    expect(derivePaymentState(payment(), 'declined')).toBe('unpaid')
  })

  it('ignores money claims on a request that was never approved', () => {
    expect(derivePaymentState(payment({ markedPaidAt: AT }), 'pending')).toBe('unpaid')
  })
})

const entry = (
  overrides: { status?: SeatRequestStatus; name?: string; payment?: Partial<SeatPayment> } = {},
): SeatPaymentEntry => {
  const request: SeatRequest = {
    id: `request-${overrides.name ?? 'x'}`,
    tableId: 'listing-1',
    hostId: 'host-1',
    userId: `user-${overrides.name ?? 'x'}`,
    message: null,
    status: overrides.status ?? 'approved',
    decidedAt: AT,
    decidedBy: 'host-1',
    createdAt: AT,
  }
  return {
    request,
    user: { id: request.userId, name: overrides.name ?? 'Guest', instagramHandle: null },
    payment: payment({ seatRequestId: request.id, ...overrides.payment }),
  }
}

describe('buildPaymentGrid', () => {
  it('attaches a state to every entry', () => {
    const rows = buildPaymentGrid([
      entry({ name: 'A' }),
      entry({ name: 'B', payment: { markedPaidAt: AT } }),
      entry({ name: 'C', payment: { markedPaidAt: AT, confirmedAt: AT } }),
    ])

    expect(rows.map((row) => row.state)).toEqual(['unpaid', 'marked_paid', 'confirmed'])
  })

  it('keeps a departed guest only when a refund is owed', () => {
    const rows = buildPaymentGrid([
      entry({ name: 'A' }),
      entry({ name: 'B', status: 'withdrawn', payment: { confirmedAt: AT } }),
      entry({ name: 'C', status: 'declined' }),
      entry({ name: 'D', status: 'removed' }),
    ])

    expect(rows.map((row) => row.user.name)).toEqual(['A', 'B'])
  })

  it('drops requests that were never approved', () => {
    const rows = buildPaymentGrid([entry({ name: 'A', status: 'pending' })])

    expect(rows).toHaveLength(0)
  })

  it('puts what needs the host\'s attention first', () => {
    const rows = buildPaymentGrid([
      entry({ name: 'Confirmed', payment: { markedPaidAt: AT, confirmedAt: AT } }),
      entry({ name: 'Unpaid' }),
      entry({ name: 'Refund', status: 'removed', payment: { confirmedAt: AT } }),
      entry({ name: 'Claimed', payment: { markedPaidAt: AT } }),
    ])

    expect(rows.map((row) => row.user.name)).toEqual(['Refund', 'Claimed', 'Unpaid', 'Confirmed'])
  })
})

describe('totalOutstanding', () => {
  it('adds up what is still owed to the host', () => {
    const rows = buildPaymentGrid([
      entry({ name: 'A' }),
      entry({ name: 'B', payment: { markedPaidAt: AT } }),
      entry({ name: 'C', payment: { markedPaidAt: AT, confirmedAt: AT } }),
    ])

    // Unpaid and marked-but-unconfirmed both still count as outstanding: the
    // host has not seen either one arrive.
    expect(totalOutstanding(rows)).toBe(5_000_000)
  })

  it('excludes refunds, which run the other way', () => {
    const rows = buildPaymentGrid([entry({ name: 'A', status: 'removed', payment: { confirmedAt: AT } })])

    expect(totalOutstanding(rows)).toBe(0)
  })

  it('is zero for an empty table', () => {
    expect(totalOutstanding([])).toBe(0)
  })
})
```

The ordering test encodes what the grid is *for*. A host opens it to answer "what do I still need to chase?", so refunds owed and unconfirmed claims come first and settled rows sink.

- [ ] **Step 4: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/settlement/derive`.

- [ ] **Step 5: Implement**

Create `lib/domain/settlement/derive.ts`:

```ts
import type { Rupiah } from '../money'
import type { SeatRequestStatus } from '../seats/types'
import type { PaymentRow, PaymentState, SeatPayment, SeatPaymentEntry } from './types'

/** Statuses in which a person no longer holds the seat they may have paid for. */
const DEPARTED: SeatRequestStatus[] = ['withdrawn', 'removed']

/** How urgently each state wants the host's attention. Lower sorts first. */
const ATTENTION_ORDER: Record<PaymentState, number> = {
  refund_owed: 0,
  marked_paid: 1,
  unpaid: 2,
  confirmed: 3,
}

export function derivePaymentState(
  payment: Pick<SeatPayment, 'markedPaidAt' | 'confirmedAt'>,
  requestStatus: SeatRequestStatus,
): PaymentState {
  const claimed = payment.markedPaidAt !== null || payment.confirmedAt !== null

  if (DEPARTED.includes(requestStatus)) {
    // Deliberately includes an unconfirmed claim. The host has not acknowledged
    // receiving the money, but the guest says they sent it — that discrepancy is
    // exactly what the host needs to look at, and the app cannot resolve it
    // either way because it never held the funds.
    return claimed ? 'refund_owed' : 'unpaid'
  }

  if (requestStatus !== 'approved') {
    // A pending or declined request has no seat, so it has no money either,
    // whatever stale row might exist alongside it.
    return 'unpaid'
  }

  if (payment.confirmedAt !== null) return 'confirmed'
  if (payment.markedPaidAt !== null) return 'marked_paid'
  return 'unpaid'
}

/**
 * The host's payment grid: every seat that currently matters, most urgent first.
 *
 * A guest who left without paying is simply absent — showing them would pad the
 * grid with rows that require nothing from anyone.
 */
export function buildPaymentGrid(entries: SeatPaymentEntry[]): PaymentRow[] {
  return entries
    .map((entry) => ({ ...entry, state: derivePaymentState(entry.payment, entry.request.status) }))
    .filter((row) => row.request.status === 'approved' || row.state === 'refund_owed')
    .sort((a, b) => {
      const byAttention = ATTENTION_ORDER[a.state] - ATTENTION_ORDER[b.state]
      if (byAttention !== 0) return byAttention
      return a.user.name.localeCompare(b.user.name)
    })
}

/** What the host is still waiting on. Refunds are not netted off — they run the other way. */
export function totalOutstanding(rows: PaymentRow[]): Rupiah {
  return rows
    .filter((row) => row.state === 'unpaid' || row.state === 'marked_paid')
    .reduce((total, row) => total + row.payment.amount, 0)
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

- [ ] **Step 7: Commit and push**

```bash
git add lib/domain/errors.ts lib/domain/settlement tests/domain/settlement
git commit -m "feat: derive per-seat payment state and the host payment grid"
git push
```

---

### Task 2: Recording and confirming payment

**Files:**
- Create: `lib/domain/settlement/ports.ts`, `lib/domain/settlement/record-payment.ts`
- Modify: `tests/support/fake-party-repository.ts`
- Test: `tests/domain/settlement/record-payment.test.ts`

**Interfaces:**
- Consumes: `SeatPayment`, `SeatPaymentEntry` (Task 1); `SeatRequest` (Plan 2 Task 6); `ListingSummary` (Plan 2 Task 1).
- Produces: `SettlementRepository`, `SettlementDeps`, `UserSeatPayment`; `markSeatPaid(deps, input): Promise<SeatPayment>`; `confirmSeatPayment(deps, input): Promise<SeatPayment>`; `MAX_PAYMENT_METHOD_LENGTH = 40`; `MAX_PAYMENT_NOTE_LENGTH = 200`.

- [ ] **Step 1: Define the settlement port**

Create `lib/domain/settlement/ports.ts`:

```ts
import type { ListingSummary } from '../tables/types'
import type { SeatRequest } from '../seats/types'
import type { SeatPayment, SeatPaymentEntry } from './types'

/** One of this member's seats, with what they owe on it and where it is. */
export interface UserSeatPayment {
  request: SeatRequest
  payment: SeatPayment
  listing: ListingSummary
}

export interface SettlementRepository {
  /**
   * The seat and its money together. Returns null when either is missing —
   * a payment row exists for every approved seat, created inside the approval
   * transaction, so a seat without one means the seat itself is gone.
   */
  findSeatPayment(requestId: string): Promise<{ request: SeatRequest; payment: SeatPayment } | null>

  listPaymentsForListing(listingId: string): Promise<SeatPaymentEntry[]>
  listPaymentsForUser(userId: string): Promise<UserSeatPayment[]>

  markPaid(requestId: string, at: Date, method: string | null): Promise<SeatPayment>
  confirmPaid(requestId: string, at: Date, confirmedBy: string, note: string | null): Promise<SeatPayment>
}

export interface SettlementDeps {
  repository: SettlementRepository
  now: () => Date
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/domain/settlement/record-payment.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { confirmSeatPayment, markSeatPaid } from '@/lib/domain/settlement/record-payment'
import { FakePartyRepository } from '../../support/fake-party-repository'

const NOW = new Date('2026-08-01T12:00:00Z')
const LATER = new Date('2026-08-02T12:00:00Z')

let repository: FakePartyRepository
let hostId: string
let guestId: string
let strangerId: string
let listingId: string

const deps = (now: Date = NOW) => ({ repository, now: () => now })

beforeEach(() => {
  repository = new FakePartyRepository()
  hostId = repository.seedUser({ name: 'Host' }).id
  guestId = repository.seedUser({ name: 'Guest' }).id
  strangerId = repository.seedUser({ name: 'Stranger' }).id
  listingId = repository.seedListing({ hostId, seatPrice: 2_500_000 }).id
})

/** An approved seat with the payment row the approval transaction creates. */
function approvedSeat(status: 'approved' | 'withdrawn' | 'removed' | 'pending' = 'approved') {
  const request = repository.seedRequest({ tableId: listingId, userId: guestId, status })
  repository.seedPayment({ seatRequestId: request.id, amount: 2_500_000 })
  return request
}

describe('markSeatPaid', () => {
  it('records the guest\'s claim with the time and method', async () => {
    const request = approvedSeat()

    const payment = await markSeatPaid(deps(), { requestId: request.id, userId: guestId, method: ' GoPay ' })

    expect(payment.markedPaidAt).toEqual(NOW)
    expect(payment.method).toBe('GoPay')
    expect(payment.confirmedAt).toBeNull()
  })

  it('accepts no method at all', async () => {
    const request = approvedSeat()

    const payment = await markSeatPaid(deps(), { requestId: request.id, userId: guestId, method: '  ' })

    expect(payment.markedPaidAt).toEqual(NOW)
    expect(payment.method).toBeNull()
  })

  it('is idempotent — a double tap does not move the timestamp', async () => {
    const request = approvedSeat()
    await markSeatPaid(deps(NOW), { requestId: request.id, userId: guestId, method: null })

    const second = await markSeatPaid(deps(LATER), { requestId: request.id, userId: guestId, method: null })

    expect(second.markedPaidAt).toEqual(NOW)
  })

  it('leaves a host-confirmed payment alone', async () => {
    const request = approvedSeat()
    await confirmSeatPayment(deps(NOW), { requestId: request.id, hostId, note: null })

    const payment = await markSeatPaid(deps(LATER), { requestId: request.id, userId: guestId, method: null })

    expect(payment.confirmedAt).toEqual(NOW)
    expect(payment.markedPaidAt).toBeNull()
  })

  it('refuses someone else\'s seat', async () => {
    const request = approvedSeat()

    await expect(markSeatPaid(deps(), { requestId: request.id, userId: strangerId, method: null }))
      .rejects.toMatchObject({ code: 'not_seat_owner' })
  })

  it('refuses a seat that is not approved', async () => {
    for (const status of ['pending', 'withdrawn', 'removed'] as const) {
      const request = approvedSeat(status)

      await expect(
        markSeatPaid(deps(), { requestId: request.id, userId: guestId, method: null }),
        `expected marking a ${status} seat to be rejected`,
      ).rejects.toMatchObject({ code: 'seat_not_approved' })
    }
  })

  it('refuses a seat that does not exist', async () => {
    await expect(markSeatPaid(deps(), { requestId: 'nope', userId: guestId, method: null }))
      .rejects.toMatchObject({ code: 'seat_payment_not_found' })
  })

  it('rejects a method longer than the limit', async () => {
    const request = approvedSeat()

    await expect(markSeatPaid(deps(), {
      requestId: request.id, userId: guestId, method: 'x'.repeat(41),
    })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('confirmSeatPayment', () => {
  it('records the host\'s confirmation with who confirmed it', async () => {
    const request = approvedSeat()
    await markSeatPaid(deps(), { requestId: request.id, userId: guestId, method: 'GoPay' })

    const payment = await confirmSeatPayment(deps(LATER), { requestId: request.id, hostId, note: ' cash ' })

    expect(payment.confirmedAt).toEqual(LATER)
    expect(payment.confirmedBy).toBe(hostId)
    expect(payment.note).toBe('cash')
  })

  it('lets the host confirm without the guest having marked anything', async () => {
    const request = approvedSeat()

    const payment = await confirmSeatPayment(deps(), { requestId: request.id, hostId, note: null })

    expect(payment.confirmedAt).toEqual(NOW)
    expect(payment.markedPaidAt).toBeNull()
  })

  it('is idempotent', async () => {
    const request = approvedSeat()
    await confirmSeatPayment(deps(NOW), { requestId: request.id, hostId, note: null })

    const second = await confirmSeatPayment(deps(LATER), { requestId: request.id, hostId, note: 'again' })

    expect(second.confirmedAt).toEqual(NOW)
  })

  it('refuses anyone who is not the host of that table', async () => {
    const request = approvedSeat()

    await expect(confirmSeatPayment(deps(), { requestId: request.id, hostId: strangerId, note: null }))
      .rejects.toMatchObject({ code: 'not_listing_host' })
  })

  it('refuses a seat that is not approved', async () => {
    const request = approvedSeat('removed')

    await expect(confirmSeatPayment(deps(), { requestId: request.id, hostId, note: null }))
      .rejects.toMatchObject({ code: 'seat_not_approved' })
  })

  it('rejects a note longer than the limit', async () => {
    const request = approvedSeat()

    await expect(confirmSeatPayment(deps(), {
      requestId: request.id, hostId, note: 'x'.repeat(201),
    })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
```

Confirming a *removed* seat is refused on purpose. Once a guest is off the table, the money owes in the other direction, and the grid already says so — letting the host tick "confirmed" there would erase the only signal that a refund is pending.

- [ ] **Step 3: Extend the fake repository**

In `tests/support/fake-party-repository.ts`, add the settlement half. Change the class declaration to include the third interface:

```ts
export class FakePartyRepository implements TablesRepository, SeatsRepository, SettlementRepository {
```

Add the imports:

```ts
import type { SettlementRepository, UserSeatPayment } from '@/lib/domain/settlement/ports'
import type { SeatPayment, SeatPaymentEntry } from '@/lib/domain/settlement/types'
```

Add the store, seeding, and methods:

```ts
  payments: SeatPayment[] = []

  seedPayment(partial: { seatRequestId: string; amount?: number }): SeatPayment {
    const payment: SeatPayment = {
      seatRequestId: partial.seatRequestId,
      amount: partial.amount ?? 2_500_000,
      markedPaidAt: null,
      confirmedAt: null,
      confirmedBy: null,
      method: null,
      note: null,
    }
    this.payments.push(payment)
    return payment
  }

  async findSeatPayment(requestId: string) {
    const request = this.requests.find((r) => r.id === requestId)
    const payment = this.payments.find((p) => p.seatRequestId === requestId)
    return request && payment ? { request, payment } : null
  }

  private entryFor(payment: SeatPayment): SeatPaymentEntry | null {
    const request = this.requests.find((r) => r.id === payment.seatRequestId)
    if (!request) return null
    const user = this.users.find((u) => u.id === request.userId)
      ?? { id: request.userId, name: 'Guest', instagramHandle: null }
    return { request, user, payment }
  }

  async listPaymentsForListing(listingId: string): Promise<SeatPaymentEntry[]> {
    return this.payments
      .map((payment) => this.entryFor(payment))
      .filter((entry): entry is SeatPaymentEntry => entry !== null && entry.request.tableId === listingId)
  }

  async listPaymentsForUser(userId: string): Promise<UserSeatPayment[]> {
    return this.payments
      .map((payment) => this.entryFor(payment))
      .filter((entry): entry is SeatPaymentEntry => entry !== null && entry.request.userId === userId)
      .map((entry) => ({
        request: entry.request,
        payment: entry.payment,
        listing: this.summarize(this.listings.find((l) => l.id === entry.request.tableId)!),
      }))
  }

  async markPaid(requestId: string, at: Date, method: string | null): Promise<SeatPayment> {
    const payment = this.payments.find((p) => p.seatRequestId === requestId)!
    payment.markedPaidAt = at
    payment.method = method
    return payment
  }

  async confirmPaid(
    requestId: string, at: Date, confirmedBy: string, note: string | null,
  ): Promise<SeatPayment> {
    const payment = this.payments.find((p) => p.seatRequestId === requestId)!
    payment.confirmedAt = at
    payment.confirmedBy = confirmedBy
    payment.note = note
    return payment
  }
```

Finally, make the fake's approval create a payment row, as the real transaction does. In `approveIfSeatAvailable`, immediately before `return { ok: true, request }`:

```ts
    if (!this.payments.some((p) => p.seatRequestId === request.id)) {
      this.seedPayment({ seatRequestId: request.id, amount: listing.seatPrice })
    }
```

A fake that skipped this would let Plan 2's tests keep passing while the real approval path silently stopped creating payment rows.

- [ ] **Step 4: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/settlement/record-payment`.

- [ ] **Step 5: Implement**

Create `lib/domain/settlement/record-payment.ts`:

```ts
import { DomainError } from '../errors'
import type { SeatRequest } from '../seats/types'
import type { SettlementDeps } from './ports'
import type { SeatPayment } from './types'

export const MAX_PAYMENT_METHOD_LENGTH = 40
export const MAX_PAYMENT_NOTE_LENGTH = 200

export interface MarkSeatPaidInput {
  requestId: string
  userId: string
  method: string | null
}

export interface ConfirmSeatPaymentInput {
  requestId: string
  hostId: string
  note: string | null
}

function clean(value: string | null, max: number, label: string): string | null {
  const trimmed = (value ?? '').trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > max) {
    throw new DomainError('invalid_input', `${label} is at most ${max} characters.`)
  }
  return trimmed
}

async function loadSeat(
  deps: SettlementDeps, requestId: string,
): Promise<{ request: SeatRequest; payment: SeatPayment }> {
  const found = await deps.repository.findSeatPayment(requestId)
  if (!found) {
    throw new DomainError('seat_payment_not_found', 'That seat no longer exists.')
  }
  return found
}

function assertApproved(request: SeatRequest): void {
  if (request.status !== 'approved') {
    throw new DomainError('seat_not_approved', 'That seat is not on the table.')
  }
}

/**
 * The guest's claim that they paid.
 *
 * Idempotent, and never overwrites a host confirmation. Once the host has said
 * the money arrived, the guest tapping again should change nothing — the
 * stronger claim already stands.
 */
export async function markSeatPaid(deps: SettlementDeps, input: MarkSeatPaidInput): Promise<SeatPayment> {
  const { request, payment } = await loadSeat(deps, input.requestId)

  if (request.userId !== input.userId) {
    throw new DomainError('not_seat_owner', 'That seat is not yours.')
  }
  assertApproved(request)

  const method = clean(input.method, MAX_PAYMENT_METHOD_LENGTH, 'The payment method')

  if (payment.confirmedAt !== null || payment.markedPaidAt !== null) return payment

  return deps.repository.markPaid(request.id, deps.now(), method)
}

/**
 * The host's confirmation that the money arrived.
 *
 * Does not require the guest to have marked it first — a host watching a
 * transfer land has no reason to wait for anyone.
 */
export async function confirmSeatPayment(
  deps: SettlementDeps, input: ConfirmSeatPaymentInput,
): Promise<SeatPayment> {
  const { request, payment } = await loadSeat(deps, input.requestId)

  // `hostId` is denormalized onto the request and kept honest by the composite
  // foreign key, so this needs no second query for the listing.
  if (request.hostId !== input.hostId) {
    throw new DomainError('not_listing_host', 'Only the host can confirm payment for this table.')
  }
  assertApproved(request)

  const note = clean(input.note, MAX_PAYMENT_NOTE_LENGTH, 'The note')

  if (payment.confirmedAt !== null) return payment

  return deps.repository.confirmPaid(request.id, deps.now(), input.hostId, note)
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

Expected: all settlement tests pass, and every Plan 2 test still passes — the fake's new payment row must not have disturbed them.

- [ ] **Step 7: Commit and push**

```bash
git add lib/domain/settlement tests/domain/settlement tests/support/fake-party-repository.ts
git commit -m "feat: add mark-paid and confirm-payment use cases"
git push
```

---

### Task 3: PostgreSQL settlement repository

**Files:**
- Create: `lib/db/repositories/settlement.ts`
- Test: `tests/integration/settlement-repository.test.ts`

**Interfaces:**
- Consumes: `SettlementRepository` (Task 2); `SUMMARY_COLUMNS`, `toSummary` (Plan 2 Task 8); `PostgresSeatsRepository` (Plan 2 Task 9).
- Produces: `class PostgresSettlementRepository implements SettlementRepository`, constructed as `new PostgresSettlementRepository(db)`.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/settlement-repository.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db/client'
import { PostgresSeatsRepository } from '@/lib/db/repositories/seats'
import { PostgresSettlementRepository } from '@/lib/db/repositories/settlement'
import { seedListing, seedRequest, seedUser, seedVenue, truncateAll } from '../support/db-helpers'

const seats = new PostgresSeatsRepository(db)
const repository = new PostgresSettlementRepository(db)

let hostId: string
let guestId: string
let venueId: string
let listingId: string

beforeEach(async () => {
  await truncateAll()
  hostId = (await seedUser({ email: 'host@example.com', name: 'Host' })).id
  guestId = (await seedUser({ email: 'guest@example.com', name: 'Guest' })).id
  venueId = (await seedVenue({ name: 'Savaya', city: 'Bali' })).id
  listingId = (await seedListing({ hostId, venueId, seatsOffered: 4, seatPrice: 2_500_000 })).id
})

/** Go through the real approval path, which is what creates the payment row. */
async function approveSeatFor(userId: string) {
  const request = await seedRequest({ tableId: listingId, hostId, userId })
  const outcome = await seats.approveIfSeatAvailable(request.id, hostId, new Date())
  if (!outcome.ok) throw new Error('approval failed to set up the test')
  return outcome.request
}

describe('findSeatPayment', () => {
  it('returns the seat with the amount captured at approval', async () => {
    const request = await approveSeatFor(guestId)

    const found = await repository.findSeatPayment(request.id)

    expect(found!.request.id).toBe(request.id)
    expect(found!.payment).toMatchObject({
      seatRequestId: request.id, amount: 2_500_000,
      markedPaidAt: null, confirmedAt: null, confirmedBy: null, method: null, note: null,
    })
    expect(typeof found!.payment.amount).toBe('number')
  })

  it('returns null for a request with no payment row', async () => {
    const request = await seedRequest({ tableId: listingId, hostId, userId: guestId })

    expect(await repository.findSeatPayment(request.id)).toBeNull()
  })

  it('returns null for a request that does not exist', async () => {
    expect(await repository.findSeatPayment('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('markPaid and confirmPaid', () => {
  it('records the guest claim', async () => {
    const request = await approveSeatFor(guestId)
    const at = new Date('2026-08-01T12:00:00.000Z')

    const payment = await repository.markPaid(request.id, at, 'GoPay')

    expect(payment.markedPaidAt).toEqual(at)
    expect(payment.method).toBe('GoPay')
  })

  it('records the host confirmation without disturbing the guest claim', async () => {
    const request = await approveSeatFor(guestId)
    const marked = new Date('2026-08-01T12:00:00.000Z')
    const confirmed = new Date('2026-08-02T12:00:00.000Z')
    await repository.markPaid(request.id, marked, 'GoPay')

    const payment = await repository.confirmPaid(request.id, confirmed, hostId, 'counted it')

    expect(payment.markedPaidAt).toEqual(marked)
    expect(payment.method).toBe('GoPay')
    expect(payment.confirmedAt).toEqual(confirmed)
    expect(payment.confirmedBy).toBe(hostId)
    expect(payment.note).toBe('counted it')
  })
})

describe('listing and user views', () => {
  it('lists every payment on a table with the guest attached', async () => {
    const other = await seedUser({ email: 'other@example.com', name: 'Other' })
    await approveSeatFor(guestId)
    await approveSeatFor(other.id)

    const entries = await repository.listPaymentsForListing(listingId)

    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.user.name).sort()).toEqual(['Guest', 'Other'])
    expect(entries.every((e) => e.payment.amount === 2_500_000)).toBe(true)
  })

  it('keeps a departed guest\'s payment row visible to the host', async () => {
    const request = await approveSeatFor(guestId)
    await repository.markPaid(request.id, new Date(), null)
    await seats.setRequestStatus(request.id, 'withdrawn', new Date(), guestId)

    const entries = await repository.listPaymentsForListing(listingId)

    expect(entries).toHaveLength(1)
    expect(entries[0].request.status).toBe('withdrawn')
    expect(entries[0].payment.markedPaidAt).not.toBeNull()
  })

  it('lists a member\'s own payments with the full listing summary', async () => {
    const request = await approveSeatFor(guestId)

    const own = await repository.listPaymentsForUser(guestId)

    expect(own).toHaveLength(1)
    expect(own[0].request.id).toBe(request.id)
    expect(own[0].listing.venue.name).toBe('Savaya')
    expect(own[0].listing.host.name).toBe('Host')
    expect(own[0].payment.amount).toBe(2_500_000)
  })

  it('gives a member nothing for tables they only host', async () => {
    await approveSeatFor(guestId)

    expect(await repository.listPaymentsForUser(hostId)).toHaveLength(0)
  })
})

describe('cascade behaviour', () => {
  it('deletes the payment row if the seat request is ever deleted', async () => {
    // seat_payments carries ON DELETE CASCADE. Nothing in the app deletes seat
    // requests, but if a future migration or a manual cleanup does, no orphan
    // payment may survive it.
    const request = await approveSeatFor(guestId)
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('drizzle-orm')).sql`delete from seat_requests where id = ${request.id}`,
    )

    expect(await repository.findSeatPayment(request.id)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm run test:integration
```

Expected: failure resolving `@/lib/db/repositories/settlement`.

- [ ] **Step 3: Implement**

Create `lib/db/repositories/settlement.ts`:

```ts
import { asc, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { seatPayments, seatRequests, tableListings, users, venues } from '../schema'
import { SUMMARY_COLUMNS, toSummary } from './tables'
import type { SettlementRepository, UserSeatPayment } from '@/lib/domain/settlement/ports'
import type { SeatPayment, SeatPaymentEntry } from '@/lib/domain/settlement/types'
import type { SeatRequest } from '@/lib/domain/seats/types'

type SeatRequestRow = typeof seatRequests.$inferSelect
type SeatPaymentRow = typeof seatPayments.$inferSelect

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

function toPayment(row: SeatPaymentRow): SeatPayment {
  return {
    seatRequestId: row.seatRequestId,
    amount: row.amount,
    markedPaidAt: row.markedPaidAt,
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
    method: row.method,
    note: row.note,
  }
}

export class PostgresSettlementRepository implements SettlementRepository {
  constructor(private readonly db: Db) {}

  async findSeatPayment(requestId: string): Promise<{ request: SeatRequest; payment: SeatPayment } | null> {
    const [row] = await this.db.select({ request: seatRequests, payment: seatPayments })
      .from(seatRequests)
      .innerJoin(seatPayments, eq(seatPayments.seatRequestId, seatRequests.id))
      .where(eq(seatRequests.id, requestId))
      .limit(1)

    return row ? { request: toSeatRequest(row.request), payment: toPayment(row.payment) } : null
  }

  async listPaymentsForListing(listingId: string): Promise<SeatPaymentEntry[]> {
    const rows = await this.db.select({
      request: seatRequests,
      payment: seatPayments,
      userId: users.id,
      userName: users.name,
      userInstagram: users.instagramHandle,
    })
      .from(seatPayments)
      .innerJoin(seatRequests, eq(seatRequests.id, seatPayments.seatRequestId))
      .innerJoin(users, eq(users.id, seatRequests.userId))
      .where(eq(seatRequests.tableId, listingId))
      .orderBy(asc(seatRequests.createdAt))

    return rows.map((row) => ({
      request: toSeatRequest(row.request),
      user: { id: row.userId, name: row.userName, instagramHandle: row.userInstagram },
      payment: toPayment(row.payment),
    }))
  }

  async listPaymentsForUser(userId: string): Promise<UserSeatPayment[]> {
    const rows = await this.db.select({
      ...SUMMARY_COLUMNS,
      request: seatRequests,
      payment: seatPayments,
    })
      .from(seatPayments)
      .innerJoin(seatRequests, eq(seatRequests.id, seatPayments.seatRequestId))
      .innerJoin(tableListings, eq(tableListings.id, seatRequests.tableId))
      .innerJoin(venues, eq(venues.id, tableListings.venueId))
      .innerJoin(users, eq(users.id, tableListings.hostId))
      .where(eq(seatRequests.userId, userId))
      .orderBy(asc(tableListings.startsAt))

    return rows.map((row) => ({
      request: toSeatRequest(row.request),
      payment: toPayment(row.payment),
      listing: toSummary(row),
    }))
  }

  async markPaid(requestId: string, at: Date, method: string | null): Promise<SeatPayment> {
    const [row] = await this.db.update(seatPayments)
      .set({ markedPaidAt: at, method })
      .where(eq(seatPayments.seatRequestId, requestId))
      .returning()
    return toPayment(row)
  }

  async confirmPaid(
    requestId: string, at: Date, confirmedBy: string, note: string | null,
  ): Promise<SeatPayment> {
    const [row] = await this.db.update(seatPayments)
      .set({ confirmedAt: at, confirmedBy, note })
      .where(eq(seatPayments.seatRequestId, requestId))
      .returning()
    return toPayment(row)
  }
}
```

Note that `listPaymentsForUser` joins `users` to the *listing's host*, not to the requesting member — `SUMMARY_COLUMNS` reads host name and handle from it. Joining it to `seat_requests.user_id` instead would silently put the guest's own name where the host's belongs on every card on `/me`.

- [ ] **Step 4: Run the integration tests**

```bash
npm run test:integration
```

Expected: all settlement-repository tests pass.

- [ ] **Step 5: Commit and push**

```bash
git add lib/db/repositories/settlement.ts tests/integration/settlement-repository.test.ts
git commit -m "feat: add Postgres settlement repository"
git push
```

---
