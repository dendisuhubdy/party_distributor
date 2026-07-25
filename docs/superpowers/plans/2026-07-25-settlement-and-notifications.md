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

### Task 4: The host's payment grid

**Files:**
- Create: `lib/settlement-service.ts`, `app/tables/[id]/manage/payment-grid.tsx`
- Modify: `app/tables/[id]/manage/actions.ts`, `app/tables/[id]/manage/page.tsx`

**Interfaces:**
- Consumes: `confirmSeatPayment` (Task 2), `buildPaymentGrid`/`totalOutstanding` (Task 1), `PostgresSettlementRepository` (Task 3).
- Produces: `settlementDeps`; `confirmPaymentAction(prev, formData)`; `<PaymentGrid rows total listingId editable />`.

- [ ] **Step 1: Wire settlement to the database**

Create `lib/settlement-service.ts`:

```ts
import { db } from '@/lib/db/client'
import { PostgresSettlementRepository } from '@/lib/db/repositories/settlement'
import type { SettlementDeps } from '@/lib/domain/settlement/ports'

export const settlementDeps: SettlementDeps = {
  repository: new PostgresSettlementRepository(db),
  now: () => new Date(),
}
```

- [ ] **Step 2: Add the confirm action**

Append to `app/tables/[id]/manage/actions.ts`:

```ts
import { confirmSeatPayment } from '@/lib/domain/settlement/record-payment'
import { settlementDeps } from '@/lib/settlement-service'
```

```ts
export async function confirmPaymentAction(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const hostId = await requireUserId()
  const listingId = text(formData, 'listingId')

  try {
    await confirmSeatPayment(settlementDeps, {
      requestId: text(formData, 'requestId'),
      hostId,
      note: text(formData, 'note') || null,
    })
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  revalidateListing(listingId)
  return {}
}
```

- [ ] **Step 3: Build the grid**

Create `app/tables/[id]/manage/payment-grid.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { formatRupiah } from '@/lib/domain/money'
import type { PaymentRow, PaymentState } from '@/lib/domain/settlement/types'
import { confirmPaymentAction, type ManageState } from './actions'

const STATE_LABEL: Record<PaymentState, string> = {
  unpaid: 'Not paid',
  marked_paid: 'Says paid',
  confirmed: 'Paid',
  refund_owed: 'Refund owed',
}

const STATE_TONE: Record<PaymentState, string> = {
  unpaid: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  marked_paid: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  confirmed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  refund_owed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
}

function ConfirmButton({ listingId, requestId }: { listingId: string; requestId: string }) {
  const [state, formAction, pending] = useActionState<ManageState, FormData>(confirmPaymentAction, {})

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit" disabled={pending}
        className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
      >
        {pending ? 'Saving…' : 'Mark received'}
      </button>
      {state.error && (
        <p role="alert" className="text-right text-sm text-red-700 dark:text-red-300">{state.error}</p>
      )}
    </form>
  )
}

export function PaymentGrid({
  rows, total, listingId, editable,
}: {
  rows: PaymentRow[]
  total: number
  listingId: string
  editable: boolean
}) {
  if (rows.length === 0) {
    return <p className="mt-2 text-sm text-neutral-500">Nothing to settle yet.</p>
  }

  return (
    <>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.request.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{row.user.name}</p>
              <p className="text-sm text-neutral-500">
                {formatRupiah(row.payment.amount)}
                {row.payment.method && <> · {row.payment.method}</>}
              </p>
              <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATE_TONE[row.state]}`}>
                {STATE_LABEL[row.state]}
              </span>
            </div>

            {editable && row.state !== 'confirmed' && row.state !== 'refund_owed' && (
              <ConfirmButton listingId={listingId} requestId={row.request.id} />
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-sm">
        <span className="text-neutral-500">Still to collect </span>
        <span className="font-medium">{formatRupiah(total)}</span>
      </p>

      {rows.some((row) => row.state === 'refund_owed') && (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          Someone paid and then left the table. Send their money back directly — the app never held it and
          cannot return it for you.
        </p>
      )}
    </>
  )
}
```

The refund banner states the boundary plainly rather than offering a button. A "Refund" control the app cannot honour would be worse than no control at all.

- [ ] **Step 4: Add the grid to the manage page**

In `app/tables/[id]/manage/page.tsx`, add the imports:

```tsx
import { buildPaymentGrid, totalOutstanding } from '@/lib/domain/settlement/derive'
import { settlementDeps } from '@/lib/settlement-service'
import { PaymentGrid } from './payment-grid'
```

Load the entries alongside the roster:

```tsx
  const paymentEntries = await settlementDeps.repository.listPaymentsForListing(listing.id)
  const paymentRows = buildPaymentGrid(paymentEntries)
```

And insert a section immediately after the "At the table" section, before "Earlier":

```tsx
      <section className="mt-8">
        <h2 className="text-sm font-medium text-neutral-500">Money</h2>
        <PaymentGrid
          rows={paymentRows}
          total={totalOutstanding(paymentRows)}
          listingId={listing.id}
          editable={!state.isCancelled}
        />
      </section>
```

`editable` is `!state.isCancelled` rather than the page's `editable`. A host must still be able to record payments for a table that has already happened — that is precisely when they are settling up.

- [ ] **Step 5: Verify manually**

```bash
npm run dev
```

With a table holding two approved guests:

1. Open `/tables/[id]/manage` → expect both guests listed under Money, both "Not paid", and "Still to collect" equal to twice the seat price.
2. Tap "Mark received" on one → it turns green, "Paid", the button disappears, and the total halves.
3. Tap it again on the other, then reload → the states persist.
4. Remove a guest whose payment is confirmed → their row turns red, "Refund owed", the banner appears, and the total does not include them.
5. Change the system clock forward past the event, or edit `starts_at` in psql, and reload → the grid still offers "Mark received".

- [ ] **Step 6: Commit and push**

```bash
git add lib/settlement-service.ts "app/tables/[id]/manage"
git commit -m "feat: add the host payment grid with confirmations"
git push
```

---

### Task 5: The guest's side of payment

**Files:**
- Modify: `app/tables/[id]/actions.ts`, `app/tables/[id]/seat-forms.tsx`, `app/tables/[id]/page.tsx`
- Modify: `app/me/page.tsx`

**Interfaces:**
- Consumes: `markSeatPaid` (Task 2), `derivePaymentState` (Task 1), `listPaymentsForUser` (Task 3).
- Produces: `markPaidAction(prev, formData)`; `<MarkPaidForm listingId requestId />`.

- [ ] **Step 1: Add the mark-paid action**

Append to `app/tables/[id]/actions.ts`:

```ts
import { markSeatPaid } from '@/lib/domain/settlement/record-payment'
import { settlementDeps } from '@/lib/settlement-service'
```

```ts
export async function markPaidAction(
  _prev: SeatActionState,
  formData: FormData,
): Promise<SeatActionState> {
  const userId = await requireUserId()
  const listingId = String(formData.get('listingId') ?? '')

  try {
    await markSeatPaid(settlementDeps, {
      requestId: String(formData.get('requestId') ?? ''),
      userId,
      method: String(formData.get('method') ?? '') || null,
    })
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  revalidateListing(listingId)
  return {}
}
```

- [ ] **Step 2: Add the form**

Append to `app/tables/[id]/seat-forms.tsx`:

```tsx
import { markPaidAction } from './actions'
```

```tsx
export function MarkPaidForm({ listingId, requestId }: { listingId: string; requestId: string }) {
  const [state, formAction, pending] = useActionState<SeatActionState, FormData>(markPaidAction, {})

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input
        name="method" maxLength={40} placeholder="How you paid (optional)"
        className="w-full rounded-lg border border-neutral-300 px-4 py-3 text-base dark:border-neutral-700 dark:bg-neutral-950"
      />
      <ErrorMessage state={state} />
      <button type="submit" disabled={pending} className={secondaryClass}>
        {pending ? 'Saving…' : "I've paid"}
      </button>
    </form>
  )
}
```

- [ ] **Step 3: Show payment status on the listing page**

In `app/tables/[id]/page.tsx`, add the imports:

```tsx
import { derivePaymentState } from '@/lib/domain/settlement/derive'
import { settlementDeps } from '@/lib/settlement-service'
import { MarkPaidForm, RequestSeatForm, WithdrawSeatForm } from './seat-forms'
```

After `mine` is computed, load this member's payment for the seat:

```tsx
  const minePayment = mine?.request.status === 'approved'
    ? await settlementDeps.repository.findSeatPayment(mine.request.id)
    : null
  const minePaymentState = minePayment
    ? derivePaymentState(minePayment.payment, minePayment.request.status)
    : null
```

Then replace the body of the `mine?.request.status === 'approved'` branch with:

```tsx
          <div className="flex flex-col gap-3">
            <p className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
              You&apos;re in. {formatRupiah(minePayment?.payment.amount ?? listing.seatPrice)} to {host.name}.
              {listing.paymentNote && <> {listing.paymentNote}</>}
            </p>

            {minePaymentState === 'confirmed' ? (
              <p className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
                {host.name} confirmed your payment. Nothing left to do.
              </p>
            ) : minePaymentState === 'marked_paid' ? (
              <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                You marked this paid. Waiting for {host.name} to confirm.
              </p>
            ) : (
              <>
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
                <MarkPaidForm listingId={listing.id} requestId={mine.request.id} />
              </>
            )}

            <WithdrawSeatForm listingId={listing.id} requestId={mine.request.id} />
          </div>
```

The amount comes from the payment row rather than the listing. They are equal today because the price freeze makes them equal, but the payment row is the one that was agreed to, and reading it here means a future change to the freeze rule cannot quietly reprice someone's existing seat.

The "marked paid, awaiting host" state is deliberately visible to the guest. Without it, a host who never confirms leaves the guest unable to tell whether anything registered.

- [ ] **Step 4: Show real payment status on `/me`**

In `app/me/page.tsx`, replace the seats section's data loading. Add imports:

```tsx
import { derivePaymentState } from '@/lib/domain/settlement/derive'
import type { PaymentState } from '@/lib/domain/settlement/types'
import { settlementDeps } from '@/lib/settlement-service'
```

Replace the `held` / `owed` computation with:

```tsx
  const [hosted, held, payments] = await Promise.all([
    tablesDeps.repository.listListingsHostedBy(userId),
    seatsDeps.repository.listSeatsHeldBy(userId),
    settlementDeps.repository.listPaymentsForUser(userId),
  ])

  const paymentByRequest = new Map(payments.map((entry) => [entry.request.id, entry]))

  const seatStates = held.map((seat) => {
    const entry = paymentByRequest.get(seat.request.id)
    const state: PaymentState | null = entry
      ? derivePaymentState(entry.payment, entry.request.status)
      : null
    return { seat, state, amount: entry?.payment.amount ?? seat.listing.listing.seatPrice }
  })

  // What this member still has to send: approved seats whose payment the host
  // has not confirmed. A seat they marked paid still counts — until the host
  // agrees it arrived, it is not settled.
  const owed = seatStates
    .filter(({ seat, state }) => seat.request.status === 'approved' && state !== 'confirmed')
    .reduce((total, { amount }) => total + amount, 0)
```

Then render the badge from the payment state, replacing the existing status badge block inside the `held.map`:

```tsx
        <ul className="mt-2 flex flex-col gap-3">
          {seatStates.map(({ seat, state }) => (
            <li key={seat.request.id}>
              <div className="flex items-center gap-2">
                {seat.request.status === 'pending' ? (
                  <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                    Waiting on the host
                  </span>
                ) : state === 'confirmed' ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    Paid
                  </span>
                ) : state === 'marked_paid' ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    Awaiting confirmation
                  </span>
                ) : (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-300">
                    To pay
                  </span>
                )}
              </div>
              <div className="mt-1">
                <ListingCard summary={seat.listing} now={now} />
              </div>
            </li>
          ))}
          {seatStates.length === 0 && (
            <li className="text-sm text-neutral-500">
              No seats yet. <Link href="/" className="underline">Find a table</Link>.
            </li>
          )}
        </ul>
```

- [ ] **Step 5: Verify manually, from both sides**

Sign in as a guest holding an approved seat:

1. `/tables/[id]` → expect the price, the pay link, and "I've paid".
2. Tap "I've paid" with method "GoPay" → expect "Waiting for {host} to confirm", and the button gone.
3. `/me` → expect the amber "Awaiting confirmation" badge and the seat still counted in "To pay".
4. As the host, tap "Mark received" → back as the guest, expect "confirmed your payment. Nothing left to do." and a green "Paid" badge on `/me`, with "To pay" now excluding it.
5. Tap "I've paid" twice quickly → the timestamp must not move:

```bash
docker compose exec -T db psql -U party -d party -c \
  "select marked_paid_at, confirmed_at, method from seat_payments"
```

- [ ] **Step 6: Run everything**

```bash
npm test && npm run test:integration && npm run lint && npm run build
```

- [ ] **Step 7: Commit and push**

```bash
git add "app/tables/[id]" app/me
git commit -m "feat: let guests mark seats paid and see their payment status"
git push
```

---

### Task 6: Email templates

`notify` is the one module that imports none of the others. It receives digests and returns messages — it never reaches back into tables, seats, or settlement.

**Files:**
- Create: `lib/domain/notify/types.ts`, `lib/domain/notify/templates.ts`
- Test: `tests/domain/notify/templates.test.ts`

**Interfaces:**
- Consumes: `formatEventTime` (Plan 2 Task 2), `formatRupiah` (Plan 1 Task 2).
- Produces: `EmailKind`, `Recipient`, `ListingDigest`, `EmailMessage`, `TemplateContext`; `newListingEmail`, `seatRequestedEmail`, `seatApprovedEmail`, `seatDeclinedEmail`, `seatRemovedEmail`, `listingCancelledEmail`, `eventReminderEmail` — each `(ctx, input) => EmailMessage`.

- [ ] **Step 1: Define the notify types**

Create `lib/domain/notify/types.ts`:

```ts
import type { Rupiah } from '../money'

export type EmailKind =
  | 'new_listing'
  | 'seat_requested'
  | 'seat_approved'
  | 'seat_declined'
  | 'seat_removed'
  | 'listing_cancelled'
  | 'event_reminder'

export interface Recipient {
  userId: string
  email: string
  name: string
}

/**
 * Everything an email needs to know about a table. Deliberately a flat value
 * rather than the `ListingSummary` the tables module uses: `notify` must not
 * depend on any other module, so callers translate at the boundary.
 */
export interface ListingDigest {
  listingId: string
  venueName: string
  eventName: string | null
  startsAt: Date
  seatPrice: Rupiah
  hostName: string
  paymentLink: string | null
  paymentNote: string | null
}

export interface EmailMessage {
  kind: EmailKind
  /**
   * The row this email is *about*. Together with `kind` and the recipient it
   * forms the `email_log` uniqueness key, so choosing it wrongly is what turns
   * "once per person" into "once per person per send attempt".
   */
  entityId: string
  to: Recipient
  subject: string
  text: string
}

export interface TemplateContext {
  /** No trailing slash. e.g. `https://wazup.party` */
  baseUrl: string
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/domain/notify/templates.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  eventReminderEmail, listingCancelledEmail, newListingEmail, seatApprovedEmail,
  seatDeclinedEmail, seatRemovedEmail, seatRequestedEmail,
} from '@/lib/domain/notify/templates'
import type { ListingDigest, Recipient } from '@/lib/domain/notify/types'

const ctx = { baseUrl: 'https://wazup.party' }

const to: Recipient = { userId: 'user-1', email: 'guest@example.com', name: 'Guest' }

const listing: ListingDigest = {
  listingId: 'listing-1',
  venueName: 'Savaya',
  eventName: 'Peggy Gou',
  // 22:00 Bali on Saturday 15 August 2026.
  startsAt: new Date('2026-08-15T14:00:00.000Z'),
  seatPrice: 2_500_000,
  hostName: 'Host',
  paymentLink: 'https://pay.example/x',
  paymentNote: 'GoPay to 0812',
}

describe('every template', () => {
  const all = [
    newListingEmail(ctx, { listing, to }),
    seatRequestedEmail(ctx, { listing, to, requestId: 'request-1', guestName: 'Guest', message: null }),
    seatApprovedEmail(ctx, { listing, to, requestId: 'request-1' }),
    seatDeclinedEmail(ctx, { listing, to, requestId: 'request-1' }),
    seatRemovedEmail(ctx, { listing, to, requestId: 'request-1' }),
    listingCancelledEmail(ctx, { listing, to }),
    eventReminderEmail(ctx, { listing, to, role: 'guest', outstanding: 2_500_000, approvedSeats: 3 }),
  ]

  it('renders the event time in Bali, never in UTC', () => {
    for (const message of all) {
      expect(message.text, `${message.kind} lost the Bali time`).toContain('Sat 15 Aug, 22:00')
      expect(message.text).not.toContain('14:00')
    }
  })

  it('links back to the table', () => {
    for (const message of all) {
      expect(message.text, `${message.kind} has no link`).toContain('https://wazup.party/tables/listing-1')
    }
  })

  it('has a subject that says what happened without needing the body', () => {
    for (const message of all) {
      expect(message.subject.length, `${message.kind} subject is empty`).toBeGreaterThan(0)
      expect(message.subject.length, `${message.kind} subject is too long`).toBeLessThanOrEqual(78)
    }
  })

  it('addresses the recipient by name', () => {
    for (const message of all) {
      expect(message.text, `${message.kind} does not greet anyone`).toContain('Guest')
    }
  })

  it('carries the recipient through unchanged', () => {
    for (const message of all) {
      expect(message.to).toEqual(to)
    }
  })
})

describe('entity ids', () => {
  it('keys listing-wide emails on the listing', () => {
    expect(newListingEmail(ctx, { listing, to }).entityId).toBe('listing-1')
    expect(listingCancelledEmail(ctx, { listing, to }).entityId).toBe('listing-1')
    expect(eventReminderEmail(ctx, {
      listing, to, role: 'guest', outstanding: 0, approvedSeats: 1,
    }).entityId).toBe('listing-1')
  })

  it('keys per-seat emails on the request', () => {
    for (const message of [
      seatRequestedEmail(ctx, { listing, to, requestId: 'request-1', guestName: 'G', message: null }),
      seatApprovedEmail(ctx, { listing, to, requestId: 'request-1' }),
      seatDeclinedEmail(ctx, { listing, to, requestId: 'request-1' }),
      seatRemovedEmail(ctx, { listing, to, requestId: 'request-1' }),
    ]) {
      expect(message.entityId, `${message.kind} is keyed wrongly`).toBe('request-1')
    }
  })
})

describe('newListingEmail', () => {
  it('leads with the venue, the price, and who is hosting', () => {
    const message = newListingEmail(ctx, { listing, to })

    expect(message.subject).toContain('Savaya')
    expect(message.text).toContain('Rp 2.500.000')
    expect(message.text).toContain('Host')
  })

  it('copes with a table that has no event name', () => {
    const message = newListingEmail(ctx, { listing: { ...listing, eventName: null }, to })

    expect(message.subject).toContain('Savaya')
    expect(message.subject).not.toContain('null')
    expect(message.text).not.toContain('null')
  })
})

describe('seatRequestedEmail', () => {
  it('tells the host who asked and what they said', () => {
    const message = seatRequestedEmail(ctx, {
      listing, to, requestId: 'request-1', guestName: 'Rina', message: 'Bringing a friend',
    })

    expect(message.subject).toContain('Rina')
    expect(message.text).toContain('Bringing a friend')
    expect(message.text).toContain('https://wazup.party/tables/listing-1/manage')
  })

  it('omits the note block entirely when there is none', () => {
    const message = seatRequestedEmail(ctx, {
      listing, to, requestId: 'request-1', guestName: 'Rina', message: null,
    })

    expect(message.text).not.toContain('null')
    expect(message.text).not.toContain('They said:')
  })
})

describe('seatApprovedEmail', () => {
  it('carries the amount and how to pay', () => {
    const message = seatApprovedEmail(ctx, { listing, to, requestId: 'request-1' })

    expect(message.text).toContain('Rp 2.500.000')
    expect(message.text).toContain('https://pay.example/x')
    expect(message.text).toContain('GoPay to 0812')
  })

  it('still works when the host gave no payment details', () => {
    const bare = { ...listing, paymentLink: null, paymentNote: null }
    const message = seatApprovedEmail(ctx, { listing: bare, to, requestId: 'request-1' })

    expect(message.text).toContain('Rp 2.500.000')
    expect(message.text).not.toContain('null')
    expect(message.text).toContain('Host')
  })
})

describe('listingCancelledEmail', () => {
  it('says the money question is between the two people', () => {
    const message = listingCancelledEmail(ctx, { listing, to })

    expect(message.subject.toLowerCase()).toContain('cancelled')
    expect(message.text).toContain('Host')
    expect(message.text.toLowerCase()).toContain('refund')
  })
})

describe('eventReminderEmail', () => {
  it('reminds a guest what they still owe', () => {
    const message = eventReminderEmail(ctx, {
      listing, to, role: 'guest', outstanding: 2_500_000, approvedSeats: 3,
    })

    expect(message.text).toContain('Rp 2.500.000')
    expect(message.text.toLowerCase()).toContain('still')
  })

  it('tells a settled guest there is nothing to do', () => {
    const message = eventReminderEmail(ctx, {
      listing, to, role: 'guest', outstanding: 0, approvedSeats: 3,
    })

    expect(message.text.toLowerCase()).toContain('all settled')
  })

  it('tells a host how many people are coming and what is uncollected', () => {
    const message = eventReminderEmail(ctx, {
      listing, to, role: 'host', outstanding: 5_000_000, approvedSeats: 3,
    })

    expect(message.text).toContain('3')
    expect(message.text).toContain('Rp 5.000.000')
    expect(message.text).toContain('https://wazup.party/tables/listing-1/manage')
  })
})
```

The first test in the file — that no template renders `14:00` — is the one worth keeping forever. An email is the single place a timezone bug cannot be corrected after the fact, because the reader cannot refresh it.

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/notify/templates`.

- [ ] **Step 4: Implement**

Create `lib/domain/notify/templates.ts`:

```ts
import { formatEventTime } from '../event-time'
import { formatRupiah, type Rupiah } from '../money'
import type { EmailMessage, ListingDigest, Recipient, TemplateContext } from './types'

interface Base {
  listing: ListingDigest
  to: Recipient
}

function listingUrl(ctx: TemplateContext, listing: ListingDigest): string {
  return `${ctx.baseUrl}/tables/${listing.listingId}`
}

function manageUrl(ctx: TemplateContext, listing: ListingDigest): string {
  return `${listingUrl(ctx, listing)}/manage`
}

/** "Savaya · Peggy Gou" or just "Savaya" — used in subjects, so it stays short. */
function title(listing: ListingDigest): string {
  return listing.eventName ? `${listing.venueName} · ${listing.eventName}` : listing.venueName
}

/** Joins the parts of a body, dropping any the caller omitted, with blank lines between. */
function body(...parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null).join('\n\n')
}

function when(listing: ListingDigest): string {
  return formatEventTime(listing.startsAt)
}

export function newListingEmail(ctx: TemplateContext, input: Base): EmailMessage {
  const { listing, to } = input
  return {
    kind: 'new_listing',
    entityId: listing.listingId,
    to,
    subject: `New table at ${title(listing)}`,
    text: body(
      `Hi ${to.name},`,
      `${listing.hostName} listed a table at ${listing.venueName}${listing.eventName ? ` for ${listing.eventName}` : ''}.`,
      `${when(listing)}\n${formatRupiah(listing.seatPrice)} per seat`,
      `Ask for a seat: ${listingUrl(ctx, listing)}`,
    ),
  }
}

export function seatRequestedEmail(
  ctx: TemplateContext,
  input: Base & { requestId: string; guestName: string; message: string | null },
): EmailMessage {
  const { listing, to, guestName, message } = input
  return {
    kind: 'seat_requested',
    entityId: input.requestId,
    to,
    subject: `${guestName} wants a seat at ${listing.venueName}`,
    text: body(
      `Hi ${to.name},`,
      `${guestName} asked for a seat at your table — ${title(listing)}, ${when(listing)}.`,
      message ? `They said:\n${message}` : null,
      `Approve or decline: ${manageUrl(ctx, listing)}`,
      `The table: ${listingUrl(ctx, listing)}`,
    ),
  }
}

export function seatApprovedEmail(ctx: TemplateContext, input: Base & { requestId: string }): EmailMessage {
  const { listing, to } = input
  return {
    kind: 'seat_approved',
    entityId: input.requestId,
    to,
    subject: `You're in at ${title(listing)}`,
    text: body(
      `Hi ${to.name},`,
      `${listing.hostName} approved your seat at ${listing.venueName}.`,
      `${when(listing)}\n${formatRupiah(listing.seatPrice)} to ${listing.hostName}`,
      listing.paymentLink ? `Pay here: ${listing.paymentLink}` : null,
      listing.paymentNote,
      `Mark it paid once you have: ${listingUrl(ctx, listing)}`,
    ),
  }
}

export function seatDeclinedEmail(ctx: TemplateContext, input: Base & { requestId: string }): EmailMessage {
  const { listing, to } = input
  return {
    kind: 'seat_declined',
    entityId: input.requestId,
    to,
    subject: `No seat this time at ${listing.venueName}`,
    text: body(
      `Hi ${to.name},`,
      `${listing.hostName} couldn't fit you in at ${title(listing)} on ${when(listing)}.`,
      `Other tables: ${ctx.baseUrl}`,
      `The table: ${listingUrl(ctx, listing)}`,
    ),
  }
}

export function seatRemovedEmail(ctx: TemplateContext, input: Base & { requestId: string }): EmailMessage {
  const { listing, to } = input
  return {
    kind: 'seat_removed',
    entityId: input.requestId,
    to,
    subject: `Your seat at ${listing.venueName} was released`,
    text: body(
      `Hi ${to.name},`,
      `${listing.hostName} released your seat at ${title(listing)} on ${when(listing)}.`,
      `If you already paid, ${listing.hostName} owes you a refund directly — this app never holds money.`,
      `The table: ${listingUrl(ctx, listing)}`,
    ),
  }
}

export function listingCancelledEmail(ctx: TemplateContext, input: Base): EmailMessage {
  const { listing, to } = input
  return {
    kind: 'listing_cancelled',
    entityId: listing.listingId,
    to,
    subject: `Cancelled: ${title(listing)}`,
    text: body(
      `Hi ${to.name},`,
      `${listing.hostName} cancelled the table at ${listing.venueName} on ${when(listing)}.`,
      `If you already paid, ${listing.hostName} owes you a refund directly — this app never holds money.`,
      `Other tables: ${ctx.baseUrl}`,
      `The table: ${listingUrl(ctx, listing)}`,
    ),
  }
}

export function eventReminderEmail(
  ctx: TemplateContext,
  input: Base & { role: 'host' | 'guest'; outstanding: Rupiah; approvedSeats: number },
): EmailMessage {
  const { listing, to, role, outstanding, approvedSeats } = input

  return {
    kind: 'event_reminder',
    entityId: listing.listingId,
    to,
    subject: `Tomorrow: ${title(listing)}`,
    text: role === 'host'
      ? body(
        `Hi ${to.name},`,
        `Your table at ${listing.venueName} is tomorrow — ${when(listing)}.`,
        `${approvedSeats} ${approvedSeats === 1 ? 'guest is' : 'guests are'} coming.`,
        outstanding > 0
          ? `${formatRupiah(outstanding)} is still uncollected.`
          : 'Everyone has paid — all settled.',
        `The roster and payments: ${manageUrl(ctx, listing)}`,
        `The table: ${listingUrl(ctx, listing)}`,
      )
      : body(
        `Hi ${to.name},`,
        `${title(listing)} is tomorrow — ${when(listing)}.`,
        outstanding > 0
          ? `You still owe ${formatRupiah(outstanding)} to ${listing.hostName}.`
          : `You're all settled with ${listing.hostName}.`,
        `The table: ${listingUrl(ctx, listing)}`,
      ),
  }
}
```

Every body is plain text. HTML would need a second template per email and a second thing to keep in sync, for an audience that will read all of this on a phone lock screen anyway.

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

- [ ] **Step 6: Commit and push**

```bash
git add lib/domain/notify tests/domain/notify
git commit -m "feat: add email templates for every state change"
git push
```

---

### Task 7: Idempotent dispatch

**Files:**
- Create: `lib/domain/notify/ports.ts`, `lib/domain/notify/dispatch.ts`
- Create: `tests/support/fake-notify.ts`
- Test: `tests/domain/notify/dispatch.test.ts`

**Interfaces:**
- Consumes: `EmailMessage`, `EmailKind` (Task 6).
- Produces: `EmailSender`, `EmailLogRepository`, `RecipientRepository`, `NotifyDeps`; `dispatch(deps, messages): Promise<DispatchResult>`; `interface DispatchResult { sent, skipped, failed }`.

- [ ] **Step 1: Define the ports**

Create `lib/domain/notify/ports.ts`:

```ts
import type { EmailKind, EmailMessage, Recipient } from './types'

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

export interface EmailLogRepository {
  /**
   * Insert an `email_log` row, returning false if one already exists.
   *
   * Backed by `unique(kind, entity_id, to_user_id)`. Claiming *before* sending
   * is what makes two concurrent dispatches of the same event send once rather
   * than twice — the loser sees false and skips.
   */
  claim(kind: EmailKind, entityId: string, toUserId: string, at: Date): Promise<boolean>

  /** Undo a claim whose send then failed, so a later retry can take it again. */
  release(kind: EmailKind, entityId: string, toUserId: string): Promise<void>
}

export interface RecipientRepository {
  findRecipient(userId: string): Promise<Recipient | null>
  findRecipients(userIds: string[]): Promise<Recipient[]>
  /** Everyone who can currently sign in. Used only by the new-listing announcement. */
  listActiveRecipients(): Promise<Recipient[]>
}

export interface NotifyDeps {
  sender: EmailSender
  log: EmailLogRepository
  recipients: RecipientRepository
  now: () => Date
  baseUrl: string
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/domain/notify/dispatch.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { dispatch } from '@/lib/domain/notify/dispatch'
import type { EmailMessage } from '@/lib/domain/notify/types'
import { FakeEmailLog, FakeEmailSender, FakeRecipients } from '../../support/fake-notify'

const NOW = new Date('2026-08-01T12:00:00Z')

let sender: FakeEmailSender
let log: FakeEmailLog
let recipients: FakeRecipients

const deps = () => ({ sender, log, recipients, now: () => NOW, baseUrl: 'https://wazup.party' })

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  kind: 'seat_approved',
  entityId: 'request-1',
  to: { userId: 'user-1', email: 'a@example.com', name: 'A' },
  subject: 'You are in',
  text: 'body',
  ...overrides,
})

beforeEach(() => {
  sender = new FakeEmailSender()
  log = new FakeEmailLog()
  recipients = new FakeRecipients()
})

describe('dispatch', () => {
  it('sends a message and records that it went out', async () => {
    const result = await dispatch(deps(), [message()])

    expect(result).toMatchObject({ sent: 1, skipped: 0 })
    expect(result.failed).toEqual([])
    expect(sender.sent).toHaveLength(1)
    expect(log.rows).toEqual([
      { kind: 'seat_approved', entityId: 'request-1', toUserId: 'user-1', at: NOW },
    ])
  })

  it('never sends the same email to the same person twice', async () => {
    await dispatch(deps(), [message()])
    const result = await dispatch(deps(), [message()])

    expect(result).toMatchObject({ sent: 0, skipped: 1 })
    expect(sender.sent).toHaveLength(1)
  })

  it('treats the same event to different people as different emails', async () => {
    await dispatch(deps(), [
      message({ to: { userId: 'user-1', email: 'a@example.com', name: 'A' } }),
      message({ to: { userId: 'user-2', email: 'b@example.com', name: 'B' } }),
    ])

    expect(sender.sent).toHaveLength(2)
  })

  it('treats different events to the same person as different emails', async () => {
    await dispatch(deps(), [
      message({ kind: 'seat_approved', entityId: 'request-1' }),
      message({ kind: 'seat_removed', entityId: 'request-1' }),
      message({ kind: 'seat_approved', entityId: 'request-2' }),
    ])

    expect(sender.sent).toHaveLength(3)
  })

  it('releases the claim when a send fails, so a retry can take it', async () => {
    sender.failOn = 'a@example.com'

    const first = await dispatch(deps(), [message()])

    expect(first.sent).toBe(0)
    expect(first.failed).toHaveLength(1)
    expect(first.failed[0].message.to.email).toBe('a@example.com')
    expect(log.rows).toEqual([])

    sender.failOn = null
    const retry = await dispatch(deps(), [message()])

    expect(retry.sent).toBe(1)
  })

  it('keeps going after one recipient fails', async () => {
    sender.failOn = 'a@example.com'

    const result = await dispatch(deps(), [
      message({ to: { userId: 'user-1', email: 'a@example.com', name: 'A' } }),
      message({ to: { userId: 'user-2', email: 'b@example.com', name: 'B' } }),
    ])

    expect(result.sent).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(sender.sent.map((m) => m.to.email)).toEqual(['b@example.com'])
  })

  it('does nothing, successfully, when given nothing', async () => {
    const result = await dispatch(deps(), [])

    expect(result).toMatchObject({ sent: 0, skipped: 0 })
    expect(result.failed).toEqual([])
  })

  it('sends one at a time rather than flooding the provider', async () => {
    await dispatch(deps(), Array.from({ length: 5 }, (_, i) =>
      message({ to: { userId: `user-${i}`, email: `${i}@example.com`, name: `U${i}` } })))

    expect(sender.maxConcurrent).toBe(1)
    expect(sender.sent).toHaveLength(5)
  })
})
```

The last test pins a decision. Sends are sequential, not `Promise.all`. The largest fan-out in this product is "new table listed" to every active member, which for a curated community is tens of people; a burst of parallel requests buys nothing and is the fastest way to hit a provider rate limit and turn a partial success into a partial mystery.

- [ ] **Step 3: Write the notify fakes**

Create `tests/support/fake-notify.ts`:

```ts
import type {
  EmailLogRepository, EmailSender, RecipientRepository,
} from '@/lib/domain/notify/ports'
import type { EmailKind, EmailMessage, Recipient } from '@/lib/domain/notify/types'

export class FakeEmailSender implements EmailSender {
  sent: EmailMessage[] = []
  /** Set to an address to make sends to it throw. */
  failOn: string | null = null

  private inFlight = 0
  maxConcurrent = 0

  async send(message: EmailMessage): Promise<void> {
    this.inFlight += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight)
    try {
      // Yield, so a caller using Promise.all would overlap and be caught.
      await Promise.resolve()
      if (this.failOn === message.to.email) throw new Error('provider is down')
      this.sent.push(message)
    } finally {
      this.inFlight -= 1
    }
  }
}

interface LogRow {
  kind: EmailKind
  entityId: string
  toUserId: string
  at: Date
}

export class FakeEmailLog implements EmailLogRepository {
  rows: LogRow[] = []

  async claim(kind: EmailKind, entityId: string, toUserId: string, at: Date): Promise<boolean> {
    const exists = this.rows.some(
      (row) => row.kind === kind && row.entityId === entityId && row.toUserId === toUserId,
    )
    if (exists) return false
    this.rows.push({ kind, entityId, toUserId, at })
    return true
  }

  async release(kind: EmailKind, entityId: string, toUserId: string): Promise<void> {
    this.rows = this.rows.filter(
      (row) => !(row.kind === kind && row.entityId === entityId && row.toUserId === toUserId),
    )
  }
}

export class FakeRecipients implements RecipientRepository {
  people: Recipient[] = []

  seed(recipient: Recipient): Recipient {
    this.people.push(recipient)
    return recipient
  }

  async findRecipient(userId: string): Promise<Recipient | null> {
    return this.people.find((person) => person.userId === userId) ?? null
  }

  async findRecipients(userIds: string[]): Promise<Recipient[]> {
    return this.people.filter((person) => userIds.includes(person.userId))
  }

  async listActiveRecipients(): Promise<Recipient[]> {
    return [...this.people]
  }
}
```

- [ ] **Step 4: Run the tests and confirm they fail**

```bash
npm test
```

Expected: failure resolving `@/lib/domain/notify/dispatch`.

- [ ] **Step 5: Implement**

Create `lib/domain/notify/dispatch.ts`:

```ts
import type { NotifyDeps } from './ports'
import type { EmailMessage } from './types'

export interface DispatchFailure {
  message: EmailMessage
  error: unknown
}

export interface DispatchResult {
  sent: number
  /** Already sent to this person for this event. Not an error. */
  skipped: number
  failed: DispatchFailure[]
}

/**
 * Send a batch of emails, at most once each per recipient, ever.
 *
 * Claim first, then send, then release the claim if the send threw. This
 * ordering is chosen against the alternative — send first, log after — which
 * cannot stop two concurrent dispatches of the same event from both sending.
 *
 * The cost is a crash landing exactly between claim and send, which loses that
 * one email permanently. v1 accepts that: there is no queue, the window is
 * milliseconds, and the day-before reminder re-states everything that matters
 * anyway. Never throws — a mail failure must not unwind whatever already
 * committed to the database.
 */
export async function dispatch(deps: NotifyDeps, messages: EmailMessage[]): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, skipped: 0, failed: [] }

  // Sequential on purpose. See the concurrency test in dispatch.test.ts.
  for (const message of messages) {
    const claimed = await deps.log.claim(message.kind, message.entityId, message.to.userId, deps.now())
    if (!claimed) {
      result.skipped += 1
      continue
    }

    try {
      await deps.sender.send(message)
      result.sent += 1
    } catch (error) {
      await deps.log.release(message.kind, message.entityId, message.to.userId).catch(() => {
        // If the release itself fails there is nothing further to try, and the
        // only consequence is one email that will not be retried.
      })
      result.failed.push({ message, error })
    }
  }

  return result
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

- [ ] **Step 7: Commit and push**

```bash
git add lib/domain/notify tests/domain/notify tests/support/fake-notify.ts
git commit -m "feat: add idempotent email dispatch with claim-before-send"
git push
```

---

### Task 8: The Resend sender and the email log

**Files:**
- Create: `lib/db/repositories/email-log.ts`, `lib/email/resend-sender.ts`, `lib/notify-service.ts`
- Modify: `.env.example`
- Test: `tests/integration/email-log-repository.test.ts`

**Interfaces:**
- Consumes: `EmailLogRepository`, `RecipientRepository`, `EmailSender`, `NotifyDeps` (Task 7).
- Produces: `PostgresEmailLogRepository`, `PostgresRecipientRepository`, `ResendEmailSender`, `notifyDeps`.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/email-log-repository.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db/client'
import { PostgresEmailLogRepository, PostgresRecipientRepository } from '@/lib/db/repositories/email-log'
import { seedUser, truncateAll } from '../support/db-helpers'
import { users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

const log = new PostgresEmailLogRepository(db)
const recipients = new PostgresRecipientRepository(db)

const AT = new Date('2026-08-01T12:00:00.000Z')

let aliceId: string
let bobId: string

beforeEach(async () => {
  await truncateAll()
  aliceId = (await seedUser({ email: 'alice@example.com', name: 'Alice' })).id
  bobId = (await seedUser({ email: 'bob@example.com', name: 'Bob' })).id
})

describe('claim', () => {
  it('succeeds the first time and fails the second', async () => {
    expect(await log.claim('seat_approved', 'request-1', aliceId, AT)).toBe(true)
    expect(await log.claim('seat_approved', 'request-1', aliceId, AT)).toBe(false)
  })

  it('treats each recipient separately', async () => {
    expect(await log.claim('seat_approved', 'request-1', aliceId, AT)).toBe(true)
    expect(await log.claim('seat_approved', 'request-1', bobId, AT)).toBe(true)
  })

  it('treats each kind and entity separately', async () => {
    expect(await log.claim('seat_approved', 'request-1', aliceId, AT)).toBe(true)
    expect(await log.claim('seat_removed', 'request-1', aliceId, AT)).toBe(true)
    expect(await log.claim('seat_approved', 'request-2', aliceId, AT)).toBe(true)
  })

  it('lets exactly one of two simultaneous claims win', async () => {
    const [first, second] = await Promise.all([
      log.claim('new_listing', 'listing-1', aliceId, AT),
      log.claim('new_listing', 'listing-1', aliceId, AT),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })
})

describe('release', () => {
  it('frees a claim so it can be taken again', async () => {
    await log.claim('seat_approved', 'request-1', aliceId, AT)

    await log.release('seat_approved', 'request-1', aliceId)

    expect(await log.claim('seat_approved', 'request-1', aliceId, AT)).toBe(true)
  })

  it('is harmless when there is nothing to release', async () => {
    await expect(log.release('seat_approved', 'never-claimed', aliceId)).resolves.toBeUndefined()
  })

  it('releases only the claim it names', async () => {
    await log.claim('seat_approved', 'request-1', aliceId, AT)
    await log.claim('seat_approved', 'request-1', bobId, AT)

    await log.release('seat_approved', 'request-1', aliceId)

    expect(await log.claim('seat_approved', 'request-1', bobId, AT)).toBe(false)
  })
})

describe('recipients', () => {
  it('finds one member', async () => {
    expect(await recipients.findRecipient(aliceId)).toEqual({
      userId: aliceId, email: 'alice@example.com', name: 'Alice',
    })
  })

  it('finds several at once', async () => {
    const found = await recipients.findRecipients([aliceId, bobId])

    expect(found.map((r) => r.name).sort()).toEqual(['Alice', 'Bob'])
  })

  it('returns nothing for an empty list rather than every member', async () => {
    expect(await recipients.findRecipients([])).toEqual([])
  })

  it('lists everyone active', async () => {
    expect(await recipients.listActiveRecipients()).toHaveLength(2)
  })

  it('never emails a suspended member', async () => {
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, bobId))

    expect(await recipients.findRecipient(bobId)).toBeNull()
    expect(await recipients.findRecipients([aliceId, bobId])).toHaveLength(1)
    expect(await recipients.listActiveRecipients()).toHaveLength(1)
  })
})
```

The "empty list" test guards a real trap: `inArray(column, [])` compiles to `in ()`, which some Drizzle versions emit as invalid SQL and others as a condition that matches nothing. Neither is what a caller wants, and the version that matched *everything* would email the entire membership.

The simultaneous-claim test is what proves the idempotency is enforced by the database rather than by a read-then-write in application code.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm run test:integration
```

Expected: failure resolving `@/lib/db/repositories/email-log`.

- [ ] **Step 3: Implement the repositories**

Create `lib/db/repositories/email-log.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { emailLog, users } from '../schema'
import type { EmailLogRepository, RecipientRepository } from '@/lib/domain/notify/ports'
import type { EmailKind, Recipient } from '@/lib/domain/notify/types'

export class PostgresEmailLogRepository implements EmailLogRepository {
  constructor(private readonly db: Db) {}

  async claim(kind: EmailKind, entityId: string, toUserId: string, at: Date): Promise<boolean> {
    // The whole idempotency mechanism: `unique(kind, entity_id, to_user_id)`
    // turns a duplicate into zero returned rows rather than a second email.
    const inserted = await this.db.insert(emailLog)
      .values({ kind, entityId, toUserId, sentAt: at })
      .onConflictDoNothing()
      .returning({ id: emailLog.id })

    return inserted.length > 0
  }

  async release(kind: EmailKind, entityId: string, toUserId: string): Promise<void> {
    await this.db.delete(emailLog).where(and(
      eq(emailLog.kind, kind),
      eq(emailLog.entityId, entityId),
      eq(emailLog.toUserId, toUserId),
    ))
  }
}

const RECIPIENT_COLUMNS = {
  userId: users.id,
  email: users.email,
  name: users.name,
}

export class PostgresRecipientRepository implements RecipientRepository {
  constructor(private readonly db: Db) {}

  async findRecipient(userId: string): Promise<Recipient | null> {
    const [row] = await this.db.select(RECIPIENT_COLUMNS).from(users)
      .where(and(eq(users.id, userId), eq(users.status, 'active')))
      .limit(1)
    return row ?? null
  }

  async findRecipients(userIds: string[]): Promise<Recipient[]> {
    // `inArray(column, [])` is not portable — depending on the Drizzle version
    // it emits invalid SQL or a predicate that matches everything. Returning
    // early is the only safe reading of "notify nobody".
    if (userIds.length === 0) return []

    return this.db.select(RECIPIENT_COLUMNS).from(users)
      .where(and(inArray(users.id, userIds), eq(users.status, 'active')))
  }

  async listActiveRecipients(): Promise<Recipient[]> {
    return this.db.select(RECIPIENT_COLUMNS).from(users).where(eq(users.status, 'active'))
  }
}
```

Every query filters on `status = 'active'`. A suspended member cannot sign in, so any link mailed to them is dead on arrival — and since suspension is a manual database operation with no UI, silently continuing to email them would make the one moderation tool in the product feel broken.

- [ ] **Step 4: Implement the sender**

Create `lib/email/resend-sender.ts`:

```ts
import { Resend } from 'resend'
import type { EmailSender } from '@/lib/domain/notify/ports'
import type { EmailMessage } from '@/lib/domain/notify/types'

export class ResendEmailSender implements EmailSender {
  private readonly client: Resend

  constructor(apiKey: string, private readonly from: string) {
    this.client = new Resend(apiKey)
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: message.to.email,
      subject: message.subject,
      text: message.text,
    })

    // The Resend SDK resolves with `{ data, error }` instead of rejecting. Not
    // checking `error` would make every failure look like a success, and
    // dispatch would record the email as sent and never retry it.
    if (error) {
      throw new Error(`Resend refused the message: ${error.name}: ${error.message}`)
    }
  }
}
```

- [ ] **Step 5: Wire it up**

Create `lib/notify-service.ts`:

```ts
import { db } from '@/lib/db/client'
import { PostgresEmailLogRepository, PostgresRecipientRepository } from '@/lib/db/repositories/email-log'
import { ResendEmailSender } from '@/lib/email/resend-sender'
import type { NotifyDeps } from '@/lib/domain/notify/ports'

function baseUrl(): string {
  const raw = process.env.APP_URL ?? process.env.AUTH_URL ?? 'http://localhost:3000'
  // Templates build `${baseUrl}/tables/...`, so a trailing slash would produce
  // a double slash in every link in every email.
  return raw.replace(/\/+$/, '')
}

export const notifyDeps: NotifyDeps = {
  sender: new ResendEmailSender(process.env.RESEND_API_KEY ?? '', process.env.EMAIL_FROM ?? ''),
  log: new PostgresEmailLogRepository(db),
  recipients: new PostgresRecipientRepository(db),
  now: () => new Date(),
  baseUrl: baseUrl(),
}
```

Add to `.env.example`:

```
# Public origin, used to build links inside emails. No trailing slash.
APP_URL=http://localhost:3000
```

- [ ] **Step 6: Run the integration tests**

```bash
npm run test:integration
```

Expected: all email-log tests pass.

- [ ] **Step 7: Commit and push**

```bash
git add lib/db/repositories/email-log.ts lib/email lib/notify-service.ts .env.example tests/integration/email-log-repository.test.ts
git commit -m "feat: add Postgres email log, recipients, and the Resend sender"
git push
```

---

### Task 9: Wire notifications into every flow

Everything up to here could send email. Nothing does. This task connects them, and every connection is best-effort: a mail failure must never unwind something that already committed.

**Files:**
- Create: `lib/notifications.ts`
- Modify: `app/tables/new/actions.ts`, `app/tables/[id]/actions.ts`, `app/tables/[id]/manage/actions.ts`

**Interfaces:**
- Consumes: templates (Task 6), `dispatch` (Task 7), `notifyDeps` (Task 8), `tablesDeps`/`seatsDeps` (Plan 2 Task 10).
- Produces: `notifyNewListing(listingId)`, `notifySeatRequested(requestId)`, `notifySeatDecision(requestId, decision)`, `notifyListingCancelled(listingId, userIds)` — all returning `Promise<void>` and never throwing.

- [ ] **Step 1: Build the notification adapter**

Create `lib/notifications.ts`:

```ts
import { dispatch, type DispatchResult } from '@/lib/domain/notify/dispatch'
import {
  listingCancelledEmail, newListingEmail, seatApprovedEmail, seatDeclinedEmail,
  seatRemovedEmail, seatRequestedEmail,
} from '@/lib/domain/notify/templates'
import type { EmailMessage, ListingDigest } from '@/lib/domain/notify/types'
import type { ListingSummary } from '@/lib/domain/tables/types'
import { notifyDeps } from '@/lib/notify-service'
import { seatsDeps } from '@/lib/seats-service'
import { tablesDeps } from '@/lib/tables-service'

const ctx = { baseUrl: notifyDeps.baseUrl }

/**
 * Translate a listing into the flat value `notify` accepts. This is the
 * boundary the module rule protects: `notify` never imports `tables`, so
 * something on this side has to do the conversion.
 *
 * Identical to the one in `lib/domain/reminders/send-reminders.ts`. Sharing it
 * would mean either module reaching across the seam this function exists to
 * define, so the duplication is deliberate.
 */
function toDigest(summary: ListingSummary): ListingDigest {
  return {
    listingId: summary.listing.id,
    venueName: summary.venue.name,
    eventName: summary.listing.eventName,
    startsAt: summary.listing.startsAt,
    seatPrice: summary.listing.seatPrice,
    hostName: summary.host.name,
    paymentLink: summary.listing.paymentLink,
    paymentNote: summary.listing.paymentNote,
  }
}

async function digestFor(listingId: string): Promise<ListingDigest | null> {
  const summary = await tablesDeps.repository.findListingSummary(listingId)
  return summary ? toDigest(summary) : null
}

/**
 * Send, and swallow everything.
 *
 * Callers invoke this after their database work has already committed. An
 * exception escaping here would surface to the host as a failed approval that
 * in fact succeeded, which is strictly worse than a missing email.
 */
async function send(messages: EmailMessage[], label: string): Promise<void> {
  if (messages.length === 0) return

  let result: DispatchResult
  try {
    result = await dispatch(notifyDeps, messages)
  } catch (error) {
    console.error(`[notify] ${label} dispatch threw`, error)
    return
  }

  for (const failure of result.failed) {
    console.error(`[notify] ${label} to ${failure.message.to.email} failed`, failure.error)
  }
}

export async function notifyNewListing(listingId: string): Promise<void> {
  const summary = await tablesDeps.repository.findListingSummary(listingId)
  if (!summary) return

  const listing = toDigest(summary)
  const everyone = await notifyDeps.recipients.listActiveRecipients()

  const messages = everyone
    // The host already knows. Emailing them their own announcement is the
    // fastest way to make the product feel like a mailing list.
    .filter((to) => to.userId !== summary.listing.hostId)
    .map((to) => newListingEmail(ctx, { listing, to }))

  await send(messages, 'new_listing')
}

export async function notifySeatRequested(requestId: string): Promise<void> {
  const request = await seatsDeps.repository.findRequestById(requestId)
  if (!request) return

  const listing = await digestFor(request.tableId)
  if (!listing) return

  const [host, guest] = await Promise.all([
    notifyDeps.recipients.findRecipient(request.hostId),
    notifyDeps.recipients.findRecipient(request.userId),
  ])
  if (!host || !guest) return

  await send([seatRequestedEmail(ctx, {
    listing, to: host, requestId: request.id, guestName: guest.name, message: request.message,
  })], 'seat_requested')
}

export async function notifySeatDecision(
  requestId: string,
  decision: 'approved' | 'declined' | 'removed',
): Promise<void> {
  const request = await seatsDeps.repository.findRequestById(requestId)
  if (!request) return

  const listing = await digestFor(request.tableId)
  if (!listing) return

  const to = await notifyDeps.recipients.findRecipient(request.userId)
  if (!to) return

  const template = decision === 'approved'
    ? seatApprovedEmail
    : decision === 'declined'
      ? seatDeclinedEmail
      : seatRemovedEmail

  await send([template(ctx, { listing, to, requestId: request.id })], `seat_${decision}`)
}

export async function notifyListingCancelled(listingId: string, userIds: string[]): Promise<void> {
  const listing = await digestFor(listingId)
  if (!listing) return

  const people = await notifyDeps.recipients.findRecipients(userIds)
  await send(people.map((to) => listingCancelledEmail(ctx, { listing, to })), 'listing_cancelled')
}
```

- [ ] **Step 2: Announce a new listing**

In `app/tables/new/actions.ts`, import the notifier:

```ts
import { notifyNewListing } from '@/lib/notifications'
```

After the `try/catch` block and before `revalidatePath('/')`:

```ts
  await notifyNewListing(listingId)
```

Placing it after the `catch` matters twice over: the listing is already committed, and `notifyNewListing` cannot throw, so nothing here can turn a created table into a rendered error.

- [ ] **Step 3: Tell the host about a request**

In `app/tables/[id]/actions.ts`, import the notifier and capture the request:

```ts
import { notifySeatRequested } from '@/lib/notifications'
```

In `requestSeatAction`, change the body so the created request is available afterwards:

```ts
  let requestId: string
  try {
    const request = await requestSeat(seatsDeps, {
      listingId,
      userId,
      message: String(formData.get('message') ?? '') || null,
    })
    requestId = request.id
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  await notifySeatRequested(requestId)
  revalidateListing(listingId)
  return {}
```

- [ ] **Step 4: Tell the guest about a decision**

In `app/tables/[id]/manage/actions.ts`, import the notifiers:

```ts
import { notifyListingCancelled, notifySeatDecision } from '@/lib/notifications'
```

In `decideAction`, remember which decision landed and notify after the `catch`:

```ts
  let decided: 'approved' | 'declined' | 'removed'
  try {
    if (decision === 'approve') { await approveSeat(seatsDeps, { requestId, hostId }); decided = 'approved' }
    else if (decision === 'decline') { await declineSeat(seatsDeps, { requestId, hostId }); decided = 'declined' }
    else if (decision === 'remove') { await removeSeat(seatsDeps, { requestId, hostId }); decided = 'removed' }
    else return { error: 'Unknown action.' }
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  await notifySeatDecision(requestId, decided)
  revalidateListing(listingId)
  return {}
```

In `cancelListingAction`, keep the cascade rather than discarding it:

```ts
  let affected: string[]
  try {
    const cascade = await cancelListing(tablesDeps, { listingId, hostId })
    // Both groups are told. The removed guests may be owed money; the declined
    // ones were only waiting, and their email says so more gently.
    affected = [...cascade.removedUserIds, ...cascade.declinedUserIds]
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  await notifyListingCancelled(listingId, affected)
  revalidateListing(listingId)
  redirect(`/tables/${listingId}`)
```

- [ ] **Step 5: Verify end to end with real email**

This needs `RESEND_API_KEY` set and `EMAIL_FROM` pointing at a sender that can reach your inbox. Until `wazup.party` is verified in Resend, that means the address registered on the Resend account — see Plan 1 Task 11.

```bash
npm run dev
```

1. List a table as one member → every *other* active member gets "New table at …". The host gets nothing.
2. Ask for a seat as a second member → the host gets "… wants a seat at …" with the note included and a link to `/manage`.
3. Approve → the guest gets "You're in at …" with the amount and the payment link.
4. Decline a different request → that guest gets "No seat this time".
5. Cancel the table → every approved and pending guest gets "Cancelled: …".

Then confirm the log recorded exactly one row per email:

```bash
docker compose exec -T db psql -U party -d party -c \
  "select kind, count(*) from email_log group by kind order by kind"
```

- [ ] **Step 6: Prove the idempotency, and prove email cannot break the app**

Approve the same seat twice by replaying the form (the second attempt is refused by the domain, so instead remove and re-approve the guest, then check the count):

```bash
docker compose exec -T db psql -U party -d party -c \
  "select kind, entity_id, count(*) from email_log group by kind, entity_id having count(*) > 1"
```

Expected: no rows. One email per kind per entity per recipient, always.

Then break the sender deliberately — set `RESEND_API_KEY=invalid` in `.env.local`, restart, and approve a seat:

Expected: the approval **succeeds**, the guest appears on the roster, a `[notify]` error is logged to the terminal, and `email_log` gains no row for it — so a retry after fixing the key would still send. If the approval fails instead, something is throwing where it must not; the `send` helper in `lib/notifications.ts` is the place to look. **Restore the key afterwards.**

- [ ] **Step 7: Run everything**

```bash
npm test && npm run test:integration && npm run lint && npm run build
```

- [ ] **Step 8: Commit and push**

```bash
git add lib/notifications.ts app/tables
git commit -m "feat: send email on new listings, requests, decisions, and cancellations"
git push
```

---

### Task 10: The day-before reminder

**Files:**
- Modify: `lib/domain/event-time.ts`
- Create: `lib/domain/reminders/send-reminders.ts`, `lib/reminders-service.ts`
- Create: `app/api/cron/reminders/route.ts`
- Test: `tests/domain/event-time.test.ts` (extend), `tests/domain/reminders/send-reminders.test.ts`

**Interfaces:**
- Consumes: `TablesRepository`, `SeatsRepository`, `SettlementRepository`, `NotifyDeps`, `buildPaymentGrid`, `totalOutstanding`, `eventReminderEmail`, `dispatch`.
- Produces: `baliDayBounds(reference, dayOffset): { from: Date; to: Date }`; `ReminderDeps`; `ReminderSummary`; `sendReminders(deps, now): Promise<ReminderSummary>`; `reminderDeps`; `POST /api/cron/reminders`.

- [ ] **Step 1: Write the failing test for the day window**

Append to `tests/domain/event-time.test.ts`:

```ts
import { baliDayBounds } from '@/lib/domain/event-time'

describe('baliDayBounds', () => {
  it('brackets the Bali day the reference instant falls in', () => {
    // 17:00 UTC on 15 Aug is 01:00 Bali on 16 Aug — the 16th, not the 15th.
    const { from, to } = baliDayBounds(new Date('2026-08-15T17:00:00Z'))

    expect(from).toEqual(new Date('2026-08-15T16:00:00.000Z')) // 16 Aug 00:00 Bali
    expect(to).toEqual(new Date('2026-08-16T16:00:00.000Z')) // 17 Aug 00:00 Bali
  })

  it('brackets tomorrow at an offset of one', () => {
    // 06:00 UTC on 15 Aug is 14:00 Bali on the 15th, so tomorrow is the 16th.
    const { from, to } = baliDayBounds(new Date('2026-08-15T06:00:00Z'), 1)

    expect(from).toEqual(new Date('2026-08-15T16:00:00.000Z')) // 16 Aug 00:00 Bali
    expect(to).toEqual(new Date('2026-08-16T16:00:00.000Z')) // 17 Aug 00:00 Bali
  })

  it('spans exactly one day', () => {
    const { from, to } = baliDayBounds(new Date('2026-08-15T06:00:00Z'), 3)

    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('crosses a month boundary', () => {
    const { from } = baliDayBounds(new Date('2026-08-31T06:00:00Z'), 1)

    expect(from).toEqual(new Date('2026-08-31T16:00:00.000Z')) // 1 Sep 00:00 Bali
  })

  it('does not shift with the process timezone', () => {
    // Same assertion as the first test; the TZ=UTC and TZ=New_York runs in
    // Task 2 Step 5 of Plan 2 are what actually exercise this.
    expect(baliDayBounds(new Date('2026-08-15T17:00:00Z')).from)
      .toEqual(new Date('2026-08-15T16:00:00.000Z'))
  })
})
```

- [ ] **Step 2: Implement it**

Append to `lib/domain/event-time.ts`:

```ts
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The half-open instant range `[from, to)` covering one Bali calendar day.
 *
 * `dayOffset` counts days from the day `reference` falls in — 1 is tomorrow.
 * Adding whole days by arithmetic is exact here only because the offset is
 * fixed: with a DST zone this would need a calendar library.
 */
export function baliDayBounds(reference: Date, dayOffset = 0): { from: Date; to: Date } {
  const asBaliClock = new Date(reference.getTime() + BALI_UTC_OFFSET_HOURS * 60 * 60 * 1000)
  const baliDay = asBaliClock.toISOString().slice(0, 10)

  const from = new Date(parseBaliDay(baliDay).getTime() + dayOffset * MS_PER_DAY)
  return { from, to: new Date(from.getTime() + MS_PER_DAY) }
}
```

Delete the local `const MS_PER_DAY` from `lib/domain/tables/list-feed.ts` and import it from here instead, or leave both — they are the same value, and duplicating a constant this well-known is not worth a cross-module import. Pick one and be consistent.

- [ ] **Step 3: Run the tests**

```bash
npm test
TZ=UTC npm test
TZ=America/New_York npm test
```

Expected: identical results from all three.

- [ ] **Step 4: Write the failing tests for the reminder run**

Create `tests/domain/reminders/send-reminders.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { sendReminders } from '@/lib/domain/reminders/send-reminders'
import { FakePartyRepository } from '../../support/fake-party-repository'
import { FakeEmailLog, FakeEmailSender, FakeRecipients } from '../../support/fake-notify'

// 14:00 Bali on 15 Aug 2026. Tomorrow is the 16th.
const NOW = new Date('2026-08-15T06:00:00Z')
/** 22:00 Bali on 16 Aug. */
const TOMORROW_NIGHT = new Date('2026-08-16T14:00:00Z')
/** 22:00 Bali on 18 Aug. */
const LATER_WEEK = new Date('2026-08-18T14:00:00Z')

let party: FakePartyRepository
let sender: FakeEmailSender
let log: FakeEmailLog
let people: FakeRecipients

let hostId: string
let guestId: string

const deps = () => ({
  tables: party,
  seats: party,
  settlement: party,
  notify: { sender, log, recipients: people, now: () => NOW, baseUrl: 'https://wazup.party' },
})

function member(name: string) {
  const user = party.seedUser({ name })
  people.seed({ userId: user.id, email: `${name.toLowerCase()}@example.com`, name })
  return user.id
}

beforeEach(() => {
  party = new FakePartyRepository()
  sender = new FakeEmailSender()
  log = new FakeEmailLog()
  people = new FakeRecipients()
  hostId = member('Host')
  guestId = member('Guest')
})

function tableTomorrow(overrides: { startsAt?: Date; seatsOffered?: number } = {}) {
  return party.seedListing({
    hostId,
    startsAt: overrides.startsAt ?? TOMORROW_NIGHT,
    seatsOffered: overrides.seatsOffered ?? 4,
    seatPrice: 2_500_000,
  })
}

function approvedGuest(tableId: string, userId: string, paid: 'no' | 'marked' | 'confirmed' = 'no') {
  const request = party.seedRequest({ tableId, userId, status: 'approved' })
  const payment = party.seedPayment({ seatRequestId: request.id, amount: 2_500_000 })
  if (paid !== 'no') payment.markedPaidAt = NOW
  if (paid === 'confirmed') { payment.confirmedAt = NOW; payment.confirmedBy = hostId }
  return request
}

describe('sendReminders', () => {
  it('emails the host and every approved guest for tomorrow\'s tables', async () => {
    const listing = tableTomorrow()
    approvedGuest(listing.id, guestId)

    const summary = await sendReminders(deps(), NOW)

    expect(summary).toMatchObject({ listings: 1, sent: 2, skipped: 0, failed: 0 })
    expect(sender.sent.map((m) => m.to.name).sort()).toEqual(['Guest', 'Host'])
    expect(sender.sent.every((m) => m.kind === 'event_reminder')).toBe(true)
  })

  it('ignores tables that are not tomorrow', async () => {
    const later = tableTomorrow({ startsAt: LATER_WEEK })
    approvedGuest(later.id, guestId)

    const summary = await sendReminders(deps(), NOW)

    expect(summary.listings).toBe(0)
    expect(sender.sent).toHaveLength(0)
  })

  it('ignores cancelled tables', async () => {
    const listing = tableTomorrow()
    approvedGuest(listing.id, guestId)
    await party.cancelListing(listing.id, hostId, NOW)

    expect((await sendReminders(deps(), NOW)).listings).toBe(0)
  })

  it('emails the host even when nobody joined', async () => {
    tableTomorrow()

    const summary = await sendReminders(deps(), NOW)

    expect(summary.sent).toBe(1)
    expect(sender.sent[0].to.name).toBe('Host')
  })

  it('skips guests who are only pending', async () => {
    const listing = tableTomorrow()
    party.seedRequest({ tableId: listing.id, userId: guestId, status: 'pending' })

    const summary = await sendReminders(deps(), NOW)

    expect(summary.sent).toBe(1)
    expect(sender.sent[0].to.name).toBe('Host')
  })

  it('tells a guest who has not paid what they owe', async () => {
    const listing = tableTomorrow()
    approvedGuest(listing.id, guestId, 'no')

    await sendReminders(deps(), NOW)

    const toGuest = sender.sent.find((m) => m.to.name === 'Guest')!
    expect(toGuest.text).toContain('Rp 2.500.000')
  })

  it('tells a confirmed guest they are settled', async () => {
    const listing = tableTomorrow()
    approvedGuest(listing.id, guestId, 'confirmed')

    await sendReminders(deps(), NOW)

    const toGuest = sender.sent.find((m) => m.to.name === 'Guest')!
    expect(toGuest.text.toLowerCase()).toContain('all settled')
  })

  it('still chases a guest whose payment the host has not confirmed', async () => {
    const listing = tableTomorrow()
    approvedGuest(listing.id, guestId, 'marked')

    await sendReminders(deps(), NOW)

    const toGuest = sender.sent.find((m) => m.to.name === 'Guest')!
    expect(toGuest.text).toContain('Rp 2.500.000')
  })

  it('tells the host how much is still uncollected', async () => {
    const other = member('Other')
    const listing = tableTomorrow()
    approvedGuest(listing.id, guestId, 'confirmed')
    approvedGuest(listing.id, other, 'no')

    await sendReminders(deps(), NOW)

    const toHost = sender.sent.find((m) => m.to.name === 'Host')!
    expect(toHost.text).toContain('Rp 2.500.000')
    expect(toHost.text).toContain('2 guests')
  })

  it('sends nothing twice, even if the cron fires twice in a day', async () => {
    const listing = tableTomorrow()
    approvedGuest(listing.id, guestId)

    await sendReminders(deps(), NOW)
    const second = await sendReminders(deps(), NOW)

    expect(second).toMatchObject({ sent: 0, skipped: 2 })
    expect(sender.sent).toHaveLength(2)
  })

  it('reports a failed send without throwing', async () => {
    const listing = tableTomorrow()
    approvedGuest(listing.id, guestId)
    sender.failOn = 'guest@example.com'

    const summary = await sendReminders(deps(), NOW)

    expect(summary).toMatchObject({ sent: 1, failed: 1 })
  })

  it('covers several tables in one run', async () => {
    const a = tableTomorrow()
    const b = tableTomorrow()
    approvedGuest(a.id, guestId)
    approvedGuest(b.id, member('Third'))

    const summary = await sendReminders(deps(), NOW)

    expect(summary.listings).toBe(2)
    expect(summary.sent).toBe(4)
  })
})
```

The double-fire test is why the reminder is keyed on the listing rather than on the day: `entity_id = listingId` with `kind = 'event_reminder'` means one reminder per person per table, forever, however many times cron runs or is re-run by hand.

- [ ] **Step 5: Implement the reminder run**

Create `lib/domain/reminders/send-reminders.ts`:

```ts
import { baliDayBounds } from '../event-time'
import { dispatch } from '../notify/dispatch'
import type { NotifyDeps } from '../notify/ports'
import { eventReminderEmail } from '../notify/templates'
import type { EmailMessage, ListingDigest } from '../notify/types'
import { buildPaymentGrid, totalOutstanding } from '../settlement/derive'
import type { SettlementRepository } from '../settlement/ports'
import type { TablesRepository } from '../tables/ports'
import type { ListingSummary } from '../tables/types'

/**
 * No `SeatsRepository` here on purpose. Who is on the table comes from the
 * payment grid, which already carries each request alongside its money — asking
 * the seats repository as well would query the same rows twice and give two
 * answers that could disagree.
 */
export interface ReminderDeps {
  tables: TablesRepository
  settlement: SettlementRepository
  notify: NotifyDeps
}

export interface ReminderSummary {
  listings: number
  sent: number
  skipped: number
  failed: number
}

function toDigest(summary: ListingSummary): ListingDigest {
  return {
    listingId: summary.listing.id,
    venueName: summary.venue.name,
    eventName: summary.listing.eventName,
    startsAt: summary.listing.startsAt,
    seatPrice: summary.listing.seatPrice,
    hostName: summary.host.name,
    paymentLink: summary.listing.paymentLink,
    paymentNote: summary.listing.paymentNote,
  }
}

/**
 * Remind everyone about tomorrow's tables, once each.
 *
 * The window is tomorrow's Bali calendar day, so a run at any hour of today
 * covers the same set of tables — a cron that drifts, retries, or runs twice
 * cannot change which tables are in scope. Idempotency comes from `email_log`
 * keyed on the listing, so a second run inside the same day sends nothing.
 *
 * Known edge: a table starting at exactly 00:00 Bali is excluded, because the
 * feed query bounds are `startsAt > from`. Nothing in this product starts at
 * midnight, and widening the bound would need a change to a query four other
 * screens depend on.
 */
export async function sendReminders(deps: ReminderDeps, now: Date): Promise<ReminderSummary> {
  const { from, to } = baliDayBounds(now, 1)
  const listings = await deps.tables.listUpcomingListings({ from, to })

  const messages: EmailMessage[] = []

  for (const summary of listings) {
    const listing = toDigest(summary)
    const rows = buildPaymentGrid(await deps.settlement.listPaymentsForListing(summary.listing.id))
    const approved = rows.filter((row) => row.request.status === 'approved')

    const host = await deps.notify.recipients.findRecipient(summary.listing.hostId)
    if (host) {
      messages.push(eventReminderEmail({ baseUrl: deps.notify.baseUrl }, {
        listing,
        to: host,
        role: 'host',
        outstanding: totalOutstanding(rows),
        approvedSeats: approved.length,
      }))
    }

    for (const row of approved) {
      const guest = await deps.notify.recipients.findRecipient(row.request.userId)
      if (!guest) continue

      messages.push(eventReminderEmail({ baseUrl: deps.notify.baseUrl }, {
        listing,
        to: guest,
        role: 'guest',
        // A guest who marked paid but has no host confirmation still owes it as
        // far as the app can tell — the same reading the host's grid takes.
        outstanding: row.state === 'confirmed' ? 0 : row.payment.amount,
        approvedSeats: approved.length,
      }))
    }
  }

  const result = await dispatch(deps.notify, messages)

  return {
    listings: listings.length,
    sent: result.sent,
    skipped: result.skipped,
    failed: result.failed.length,
  }
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npm test && npm run lint
```

The lint run is doing real work here: `send-reminders.ts` sits in `lib/domain` and imports from four other domain modules. If it accidentally reaches for `@/lib/db` or a service file, the domain-purity rule fails the build.

- [ ] **Step 7: Wire it and expose the route**

Create `lib/reminders-service.ts`:

```ts
import type { ReminderDeps } from '@/lib/domain/reminders/send-reminders'
import { notifyDeps } from '@/lib/notify-service'
import { settlementDeps } from '@/lib/settlement-service'
import { tablesDeps } from '@/lib/tables-service'

export const reminderDeps: ReminderDeps = {
  tables: tablesDeps.repository,
  settlement: settlementDeps.repository,
  notify: notifyDeps,
}
```

Create `app/api/cron/reminders/route.ts`:

```ts
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sendReminders } from '@/lib/domain/reminders/send-reminders'
import { reminderDeps } from '@/lib/reminders-service'

// Never cached: this route has side effects and must run on every call.
export const dynamic = 'force-dynamic'

function authorized(request: Request, secret: string): boolean {
  const provided = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`

  // Compare in constant time. The buffers must match in length first, because
  // timingSafeEqual throws on a length mismatch rather than returning false.
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not set' }, { status: 503 })
  }
  if (!authorized(request, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const summary = await sendReminders(reminderDeps, new Date())
  return NextResponse.json(summary)
}
```

There is no `GET` handler on purpose. A URL that fires email on a plain visit gets triggered by link previews, security scanners, and any crawler that finds it in a log.

- [ ] **Step 8: Verify the route by hand**

```bash
npm run dev
```

Set `CRON_SECRET` in `.env.local`, then:

```bash
# Wrong secret
curl -i -X POST -H "Authorization: Bearer wrong" http://localhost:3000/api/cron/reminders
# Expect: 401

# No header at all
curl -i -X POST http://localhost:3000/api/cron/reminders
# Expect: 401

# GET
curl -i http://localhost:3000/api/cron/reminders
# Expect: 405

# Correct secret
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reminders
# Expect: {"listings":N,"sent":M,"skipped":0,"failed":0}
```

Set a table's `starts_at` to tomorrow evening in Bali first, so there is something to remind about:

```bash
docker compose exec -T db psql -U party -d party -c \
  "update table_listings set starts_at = (current_date + interval '1 day' + interval '22 hours') at time zone 'Asia/Makassar'"
```

Then call the endpoint twice. The second call must report `sent: 0` with a non-zero `skipped`.

- [ ] **Step 9: Schedule it on the Droplet**

Plan 1 Task 11 already installs a nightly `pg_dump`. Add the reminder next to it. On the Droplet:

```bash
cat >/etc/cron.d/party-reminders <<'CRON'
# Day-before reminders. 10:00 UTC is 18:00 in Bali — late enough that a host
# has seen the day's requests, early enough to still chase a payment.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 10 * * * root . /opt/party/.env.cron && curl -fsS --max-time 120 -X POST -H "Authorization: Bearer $CRON_SECRET" https://wazup.party/api/cron/reminders >>/var/log/party-reminders.log 2>&1
CRON
chmod 0644 /etc/cron.d/party-reminders

# The secret, kept out of the crontab so `ps` and the file mode do not leak it.
printf 'CRON_SECRET=%s\n' "$(grep '^CRON_SECRET=' /opt/party/.env | cut -d= -f2-)" >/opt/party/.env.cron
chmod 0600 /opt/party/.env.cron
```

Verify it will run, then force one run now:

```bash
systemctl status cron --no-pager
run-parts --test /etc/cron.daily >/dev/null; echo "cron is alive"
. /opt/party/.env.cron && curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" https://wazup.party/api/cron/reminders
```

A `/etc/cron.d` file needs the trailing newline the heredoc provides and a username field (`root`) that a user crontab does not have. Both are easy to get wrong, and cron fails silently when they are.

- [ ] **Step 10: Commit and push**

```bash
git add lib/domain/event-time.ts lib/domain/reminders lib/reminders-service.ts app/api/cron tests/domain
git commit -m "feat: add the day-before reminder and its cron endpoint"
git push
```

---

### Task 11: Playwright, four paths only

End-to-end tests are slow and brittle. Four load-bearing ones beat forty.

**Files:**
- Create: `playwright.config.ts`, `e2e/support/db.ts`, `e2e/support/fixtures.ts`
- Create: `e2e/invite-to-signup.spec.ts`, `e2e/create-a-table.spec.ts`, `e2e/request-approve-pay.spec.ts`, `e2e/cancel-cascades.spec.ts`
- Modify: `package.json`, `.env.example`, `.gitignore`

**Interfaces:**
- Consumes: the whole running application.
- Produces: `npm run test:e2e`; an `asMember` fixture that signs a seeded member in without any email.

- [ ] **Step 1: Install Playwright and create its database**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

E2E gets its own database so a run cannot truncate the integration suite's data mid-flight:

```bash
docker compose exec -T db psql -U party -d party -c "CREATE DATABASE party_e2e"
E2E_DATABASE_URL=postgres://party:party@localhost:5433/party_e2e
DATABASE_URL=$E2E_DATABASE_URL npm run db:migrate
```

Add to `.env.example`:

```
E2E_DATABASE_URL=postgres://party:party@localhost:5433/party_e2e
```

Add to `.gitignore`:

```
/test-results
/playwright-report
/playwright/.cache
```

Add to `package.json` scripts:

```json
"test:e2e": "playwright test"
```

- [ ] **Step 2: Configure Playwright**

Create `playwright.config.ts`:

```ts
import 'dotenv/config'
import { defineConfig, devices } from '@playwright/test'

const DATABASE_URL = process.env.E2E_DATABASE_URL
if (!DATABASE_URL) throw new Error('E2E_DATABASE_URL is not set. See .env.example.')

const BASE_URL = 'http://localhost:3100'

export default defineConfig({
  testDir: './e2e',
  // Every spec shares one database and truncates it, so they must not overlap.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: BASE_URL,
    // A phone, because that is the only device this product is used on.
    ...devices['iPhone 13'],
    trace: 'retain-on-failure',
  },
  webServer: {
    // The dev server, not a production build: a build per run would add a
    // minute to every invocation, and none of these four paths depends on
    // production-only behaviour. Port 3100 keeps it clear of `npm run dev`.
    command: 'npm run dev -- --port 3100',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL,
      AUTH_URL: BASE_URL,
      APP_URL: BASE_URL,
      AUTH_SECRET: process.env.AUTH_SECRET ?? 'e2e-secret-not-for-production',
      // Deliberately invalid. Nothing in these tests reads an inbox, and a
      // failing sender proves email cannot break the flows underneath it.
      RESEND_API_KEY: 'e2e-invalid-key',
      EMAIL_FROM: 'Party <onboarding@resend.dev>',
    },
  },
})
```

- [ ] **Step 3: Write the database helper**

Create `e2e/support/db.ts`:

```ts
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const url = process.env.E2E_DATABASE_URL
if (!url) throw new Error('E2E_DATABASE_URL is not set')

export const sql = postgres(url, { max: 4 })

export async function truncateAll(): Promise<void> {
  await sql`
    truncate table
      email_log, seat_payments, seat_requests, table_listings,
      venues, invites, sessions, accounts, verification_tokens, users
    restart identity cascade
  `
}

export async function createMember(name: string, email = `${name.toLowerCase()}@example.com`) {
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, name) values (${email}, ${name}) returning id
  `
  return { id: user.id, name, email }
}

export async function createVenue(name = 'Savaya', city = 'Bali') {
  const [venue] = await sql<{ id: string }[]>`
    insert into venues (name, city) values (${name}, ${city}) returning id
  `
  return venue.id
}

export async function createInvite(createdBy: string, code = 'ABCD-EFGH') {
  const [invite] = await sql<{ id: string; code: string }[]>`
    insert into invites (code, created_by, expires_at)
    values (${code}, ${createdBy}, now() + interval '30 days')
    returning id, code
  `
  return invite
}

/**
 * Mint a database session for a member and return its token.
 *
 * Auth.js is configured with `session: { strategy: 'database' }`, so a session
 * is exactly one row plus one cookie. Writing both directly is what lets these
 * tests sign in without an inbox — and it needs no test-only route in the
 * application, which would be a live session-minting endpoint in production.
 */
export async function createSession(userId: string): Promise<string> {
  const token = randomUUID()
  await sql`
    insert into sessions (session_token, user_id, expires)
    values (${token}, ${userId}, now() + interval '1 day')
  `
  return token
}

export async function seatStatuses(tableId: string) {
  return sql<{ user_id: string; status: string }[]>`
    select user_id, status from seat_requests where table_id = ${tableId}
  `
}
```

- [ ] **Step 4: Write the sign-in fixture**

Create `e2e/support/fixtures.ts`:

```ts
import { test as base, type BrowserContext } from '@playwright/test'
import { createSession, truncateAll } from './db'

/**
 * The cookie Auth.js reads. Over plain HTTP it is unprefixed; over HTTPS it
 * becomes `__Secure-authjs.session-token`. These tests run on http://localhost.
 *
 * If the fixture ever stops signing anyone in, verify this name first: sign in
 * by hand in a real browser and read the cookie back. A wrong name here fails
 * as a silent redirect to /login, not as an error.
 */
const SESSION_COOKIE = 'authjs.session-token'

export interface Member {
  id: string
  name: string
  email: string
}

async function signIn(context: BrowserContext, member: Member): Promise<void> {
  const token = await createSession(member.id)
  await context.addCookies([{
    name: SESSION_COOKIE,
    value: token,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  }])
}

export const test = base.extend<{
  /** Sign the given member into a browser context. */
  asMember: (context: BrowserContext, member: Member) => Promise<void>
}>({
  asMember: async ({}, use) => {
    await use(signIn)
  },
})

test.beforeEach(async () => {
  await truncateAll()
})

export { expect } from '@playwright/test'
```

- [ ] **Step 5: Path one — invite to signup**

Create `e2e/invite-to-signup.spec.ts`:

```ts
import { createInvite, createMember, sql } from './support/db'
import { expect, test } from './support/fixtures'

test('an invited person becomes a member with their own codes', async ({ page }) => {
  const founder = await createMember('Founder')
  const invite = await createInvite(founder.id, 'JOIN-TEST')

  await page.goto(`/join?code=${invite.code}`)

  // The code arrives prefilled, which is what makes a shared link work in one tap.
  await expect(page.locator('input[name="code"]')).toHaveValue(invite.code)

  await page.fill('input[name="name"]', 'Rina')
  await page.fill('input[name="email"]', 'rina@example.com')
  await page.fill('input[name="instagramHandle"]', '@rina')
  await page.click('button[type="submit"]')

  // The account and the invite are asserted in the database rather than on
  // screen. The last thing joinAction does is request a magic link, and the
  // sender is deliberately misconfigured in this suite — so the page that
  // renders next is not the interesting outcome. That the account exists,
  // attributed to its inviter, and that the code is spent, is.
  await expect(async () => {
    const [created] = await sql<{ id: string; invited_by: string; instagram_handle: string }[]>`
      select id, invited_by, instagram_handle from users where email = 'rina@example.com'
    `
    expect(created).toBeDefined()
    expect(created.invited_by).toBe(founder.id)
    expect(created.instagram_handle).toBe('@rina')

    const [used] = await sql<{ redeemed_by: string; redeemed_at: Date }[]>`
      select redeemed_by, redeemed_at from invites where id = ${invite.id}
    `
    expect(used.redeemed_by).toBe(created.id)
    expect(used.redeemed_at).not.toBeNull()
  }).toPass()
})

test('a spent code cannot be used again', async ({ page }) => {
  const founder = await createMember('Founder')
  const invite = await createInvite(founder.id, 'ONCE-ONLY')
  await sql`
    update invites set redeemed_by = ${founder.id}, redeemed_at = now() where id = ${invite.id}
  `

  await page.goto(`/join?code=${invite.code}`)
  await page.fill('input[name="name"]', 'Too Late')
  await page.fill('input[name="email"]', 'toolate@example.com')
  await page.click('button[type="submit"]')

  await expect(page.getByRole('alert')).toContainText('already been used')

  const rows = await sql`select id from users where email = 'toolate@example.com'`
  expect(rows).toHaveLength(0)
})
```

- [ ] **Step 6: Path two — create a table**

Create `e2e/create-a-table.spec.ts`:

```ts
import { createMember, createVenue, sql } from './support/db'
import { expect, test } from './support/fixtures'

test('a host lists a table and it appears on the feed', async ({ page, context, asMember }) => {
  const host = await createMember('Host')
  await createVenue('Savaya')
  await asMember(context, host)

  await page.goto('/tables/new')

  await page.selectOption('select[name="venueId"]', { label: 'Savaya' })
  // Bali wall-clock time. The assertion below is what proves it is stored as such.
  await page.fill('input[name="startsAt"]', '2099-08-15T22:00')
  await page.fill('input[name="seatsOffered"]', '4')
  await page.fill('input[name="seatPrice"]', '2.500.000')
  await page.fill('input[name="eventName"]', 'Peggy Gou')
  await page.fill('input[name="paymentNote"]', 'GoPay to 0812')
  await page.click('button[type="submit"]')

  await expect(page).toHaveURL(/\/tables\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: 'Savaya' })).toBeVisible()
  await expect(page.getByText('Peggy Gou')).toBeVisible()
  await expect(page.getByText('Rp 2.500.000')).toBeVisible()
  await expect(page.getByText('4 of 4 left')).toBeVisible()

  const [stored] = await sql<{ bali: string; seat_price: string }[]>`
    select to_char(starts_at at time zone 'Asia/Makassar', 'YYYY-MM-DD HH24:MI') as bali,
           seat_price
    from table_listings
  `
  // 22:00 Bali, not 22:00 UTC. This single assertion is the reason the whole
  // event-time module exists.
  expect(stored.bali).toBe('2099-08-15 22:00')
  expect(Number(stored.seat_price)).toBe(2_500_000)

  await page.goto('/')
  await expect(page.getByText('Savaya')).toBeVisible()
  await expect(page.getByText('4 left')).toBeVisible()
})
```

- [ ] **Step 7: Path three — request, approve, mark paid**

Create `e2e/request-approve-pay.spec.ts`:

```ts
import { createMember, createVenue, sql } from './support/db'
import { expect, test } from './support/fixtures'

test('a guest asks, the host approves, the guest pays, the host confirms', async ({
  browser, page, context, asMember,
}) => {
  const host = await createMember('Host')
  const guest = await createMember('Rina')
  const venueId = await createVenue('Savaya')

  const [listing] = await sql<{ id: string }[]>`
    insert into table_listings (host_id, venue_id, starts_at, seats_offered, seat_price, payment_note)
    values (${host.id}, ${venueId}, now() + interval '10 days', 2, 2500000, 'GoPay to 0812')
    returning id
  `

  // --- the guest asks ---
  await asMember(context, guest)
  await page.goto(`/tables/${listing.id}`)
  await page.fill('textarea[name="message"]', 'Bringing a friend later')
  await page.click('button:has-text("Ask for a seat")')
  await expect(page.getByText('will decide')).toBeVisible()

  // --- the host approves ---
  const hostContext = await browser.newContext()
  await asMember(hostContext, host)
  const hostPage = await hostContext.newPage()

  await hostPage.goto(`/tables/${listing.id}/manage`)
  await expect(hostPage.getByText('Bringing a friend later')).toBeVisible()
  await hostPage.click('button:has-text("Approve")')
  await expect(hostPage.getByText('At the table (1)')).toBeVisible()

  // The approval created the payment row, at the price agreed at that moment.
  const [payment] = await sql<{ amount: string }[]>`select amount from seat_payments`
  expect(Number(payment.amount)).toBe(2_500_000)

  // --- the guest marks it paid ---
  await page.reload()
  await expect(page.getByText("You're in")).toBeVisible()
  await page.fill('input[name="method"]', 'GoPay')
  await page.click('button:has-text("I\'ve paid")')
  await expect(page.getByText('Waiting for Host to confirm')).toBeVisible()

  // --- the host confirms ---
  await hostPage.reload()
  await expect(hostPage.getByText('Says paid')).toBeVisible()
  await hostPage.click('button:has-text("Mark received")')
  await expect(hostPage.getByText('Paid', { exact: true })).toBeVisible()
  await expect(hostPage.getByText('Still to collect Rp 0')).toBeVisible()

  // --- the guest sees it settled ---
  await page.reload()
  await expect(page.getByText('confirmed your payment')).toBeVisible()

  await page.goto('/me')
  await expect(page.getByText('Paid', { exact: true })).toBeVisible()

  // Every one of those steps ran with a deliberately broken email sender. That
  // the flow completed at all is the proof that email is best-effort.
  const logged = await sql`select kind from email_log`
  expect(logged).toHaveLength(0)

  await hostContext.close()
})

test('the last seat cannot be sold twice', async ({ browser, page, context, asMember }) => {
  const host = await createMember('Host')
  const first = await createMember('First')
  const second = await createMember('Second')
  const venueId = await createVenue('Savaya')

  const [listing] = await sql<{ id: string }[]>`
    insert into table_listings (host_id, venue_id, starts_at, seats_offered, seat_price)
    values (${host.id}, ${venueId}, now() + interval '10 days', 1, 2500000)
    returning id
  `
  for (const guest of [first, second]) {
    await sql`
      insert into seat_requests (table_id, host_id, user_id)
      values (${listing.id}, ${host.id}, ${guest.id})
    `
  }

  await asMember(context, host)
  await page.goto(`/tables/${listing.id}/manage`)

  const approveButtons = page.locator('button:has-text("Approve")')
  await approveButtons.first().click()
  await expect(page.getByText('At the table (1)')).toBeVisible()

  await page.locator('button:has-text("Approve")').first().click()
  await expect(page.getByRole('alert')).toContainText('just filled up')

  const approved = await sql`select id from seat_requests where status = 'approved'`
  expect(approved).toHaveLength(1)

  // The second guest, still pending, sees the table as full rather than as broken.
  const guestContext = await browser.newContext()
  await asMember(guestContext, second)
  const guestPage = await guestContext.newPage()
  await guestPage.goto(`/tables/${listing.id}`)
  await expect(guestPage.getByText('will decide')).toBeVisible()

  await guestContext.close()
})
```

- [ ] **Step 8: Path four — cancelling cascades**

Create `e2e/cancel-cascades.spec.ts`:

```ts
import { createMember, createVenue, seatStatuses, sql } from './support/db'
import { expect, test } from './support/fixtures'

test('cancelling a table releases everyone and says so', async ({ browser, page, context, asMember }) => {
  const host = await createMember('Host')
  const approved = await createMember('Approved')
  const waiting = await createMember('Waiting')
  const venueId = await createVenue('Savaya')

  const [listing] = await sql<{ id: string }[]>`
    insert into table_listings (host_id, venue_id, starts_at, seats_offered, seat_price)
    values (${host.id}, ${venueId}, now() + interval '10 days', 4, 2500000)
    returning id
  `
  await sql`
    insert into seat_requests (table_id, host_id, user_id, status)
    values (${listing.id}, ${host.id}, ${approved.id}, 'approved')
  `
  await sql`
    insert into seat_payments (seat_request_id, amount, marked_paid_at, confirmed_at, confirmed_by)
    select id, 2500000, now(), now(), ${host.id} from seat_requests where user_id = ${approved.id}
  `
  await sql`
    insert into seat_requests (table_id, host_id, user_id, status)
    values (${listing.id}, ${host.id}, ${waiting.id}, 'pending')
  `

  await asMember(context, host)
  await page.goto(`/tables/${listing.id}/manage`)

  // Two deliberate taps: the disclosure, then the destructive button inside it.
  await page.click('summary:has-text("Cancel this table")')
  await page.click('button:has-text("Yes, cancel the table")')

  await expect(page).toHaveURL(`/tables/${listing.id}`)
  await expect(page.getByText('This table was cancelled')).toBeVisible()

  const statuses = Object.fromEntries(
    (await seatStatuses(listing.id)).map((row) => [row.user_id, row.status]),
  )
  expect(statuses[approved.id]).toBe('removed')
  expect(statuses[waiting.id]).toBe('declined')

  // The cancelled table leaves the feed entirely.
  await page.goto('/')
  await expect(page.getByText('No tables coming up')).toBeVisible()

  // The guest who paid still sees the table, and it is not offering them anything.
  const guestContext = await browser.newContext()
  await asMember(guestContext, approved)
  const guestPage = await guestContext.newPage()
  await guestPage.goto(`/tables/${listing.id}`)
  await expect(guestPage.getByText('This table was cancelled')).toBeVisible()
  await expect(guestPage.locator('button:has-text("Ask for a seat")')).toHaveCount(0)

  await guestContext.close()
})
```

- [ ] **Step 9: Run them**

```bash
npm run test:e2e
```

Expected: 6 tests across 4 files, all passing.

If every test fails with a redirect to `/login`, the session cookie name in `e2e/support/fixtures.ts` is wrong for your Auth.js version. Sign in by hand at `http://localhost:3000`, then read the name back:

```bash
# In the browser devtools console on the signed-in page:
document.cookie
# Or, more reliably, check Application → Cookies for the httpOnly one.
```

Fix `SESSION_COOKIE` to match and re-run. Do not work around it by adding a test-only sign-in route — that route would exist in production.

- [ ] **Step 10: Commit and push**

```bash
git add playwright.config.ts e2e package.json package-lock.json .env.example .gitignore
git commit -m "test: add four end-to-end paths with Playwright"
git push
```

---

### Task 12: Cut over to wazup.party and make email real

The last task in the project, and the one that turns a working app into a product other people can use. Plan 1 shipped to an `sslip.io` hostname with Resend's shared test sender, which meant only the founder could ever receive a sign-in link. A real domain fixes both at once.

**This task supersedes the `sslip.io` hostname in Plan 1 Task 11.** Everything else there — the Droplet, the Compose stack, the nightly `pg_dump`, the firewall — stands unchanged.

**Files:**
- Modify: `Caddyfile`, `.env` on the Droplet, `.env.example`, `README.md`
- Modify: `docs/superpowers/specs/2026-07-25-party-table-splitting-design.md`

**Interfaces:**
- Consumes: the deployment from Plan 1 Task 11; `APP_URL` (Task 8).
- Produces: the app served at `https://wazup.party` with a real certificate, and magic links that reach anybody.

- [ ] **Step 1: Point the domain at the Droplet**

In the Cloudflare dashboard for `wazup.party`, create:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | the Droplet's IPv4 | **DNS only** |
| A | `www` | the Droplet's IPv4 | **DNS only** |

**Proxy must be off (grey cloud), at least to begin with.** Caddy obtains its own Let's Encrypt certificate, and Cloudflare's proxy terminates TLS itself. Left on the default "Flexible" SSL mode, the proxy speaks plain HTTP to the origin while Caddy redirects HTTP to HTTPS — an infinite redirect loop that looks exactly like an application bug. Off, Caddy's certificate is the one browsers see, and the app sees real client IPs.

Turning the proxy on later is fine, but only after setting SSL/TLS mode to **Full (strict)** so Cloudflare validates Caddy's certificate. Do that as a separate change, once the site is confirmed working.

Wait for propagation:

```bash
dig +short wazup.party
dig +short www.wazup.party
```

Both must return the Droplet's IP before continuing. Caddy's HTTP-01 challenge fails if the name does not yet resolve, and repeated failures hit Let's Encrypt rate limits.

- [ ] **Step 2: Serve the domain**

Replace `Caddyfile`:

```
wazup.party {
	encode zstd gzip
	reverse_proxy web:3000
}

www.wazup.party {
	redir https://wazup.party{uri} permanent
}
```

Caddy provisions and renews certificates for both names automatically. There is no ACME configuration to write — that is the entire reason Caddy is in this stack rather than nginx.

- [ ] **Step 3: Update the environment on the Droplet**

```bash
ssh root@<droplet-ip>
cd /opt/party
```

Edit `.env` so it contains:

```
DATABASE_URL=postgres://party:party@db:5432/party
AUTH_URL=https://wazup.party
APP_URL=https://wazup.party
AUTH_TRUST_HOST=true
AUTH_SECRET=<the existing secret — do not regenerate, it invalidates every session>
RESEND_API_KEY=<your key>
EMAIL_FROM=Party <hello@wazup.party>
CRON_SECRET=<the existing secret>
FOUNDER_EMAIL=<your email>
FOUNDER_NAME=<your name>
```

`AUTH_TRUST_HOST=true` is required because Auth.js sits behind Caddy and would otherwise refuse to trust the forwarded `Host` header, rejecting every callback. `APP_URL` is what `lib/notify-service.ts` builds email links from — leave it unset and every link in every email points at `localhost:3000`.

Mirror the new key in `.env.example` so a fresh checkout knows it exists:

```
APP_URL=https://wazup.party
```

- [ ] **Step 4: Deploy and verify TLS**

```bash
cd /opt/party && git pull && docker compose up -d --build
docker compose logs -f caddy   # watch the certificate being issued, then Ctrl-C
```

From your laptop:

```bash
curl -sSI https://wazup.party | head -1
# Expect: HTTP/2 200

curl -sSI http://wazup.party | head -3
# Expect: a 308 or 301 to https://

curl -sSI https://www.wazup.party | head -3
# Expect: a 301 to https://wazup.party/

echo | openssl s_client -connect wazup.party:443 -servername wazup.party 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
# Expect: issuer Let's Encrypt, subject CN=wazup.party, not expired
```

- [ ] **Step 5: Verify the domain in Resend**

In the Resend dashboard, add the domain `wazup.party`. Resend will show a set of records — a DKIM record, an SPF `TXT`, and an `MX` for a `send` subdomain. **Copy them exactly from the dashboard**; the hostnames and the SES region in the `MX` target differ between accounts, so any values written down here would be wrong for yours.

Two Cloudflare-specific things will otherwise cost an afternoon:

- **Set every Resend record to "DNS only".** Cloudflare cannot proxy a DKIM `CNAME` or an `MX`, and a proxied record silently fails verification.
- **Cloudflare adds its own SPF entry** if email routing was ever enabled on the zone. Two separate `TXT` records both starting `v=spf1` is invalid SPF and fails as hard as none. Merge them into one record, or remove the unused one.

Then add a DMARC record so mailbox providers know what to do with anything that fails the above:

| Type | Name | Content |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<your email>` |

`p=none` is deliberate for a new sending domain: it reports failures without having them rejected while the configuration settles. Tighten it to `quarantine` once the reports are clean.

Wait for Resend to show the domain as **Verified**.

- [ ] **Step 6: Prove a stranger can now sign in**

This is the check the whole task exists for. On the live site, with a member who is **not** the Resend account owner:

1. Issue an invite from `/invites` as the founder and send the link to a second person.
2. They open `/join?code=…`, sign up, and receive a sign-in email at their own address.
3. They click it and land signed in on the feed.

Then confirm the email links point at the real origin, not localhost:

```bash
docker compose exec -T db psql -U party -d party -c \
  "select kind, sent_at from email_log order by sent_at desc limit 5"
```

and read any received email's body — every URL must begin `https://wazup.party`.

If links say `localhost:3000`, `APP_URL` is missing from `.env` on the Droplet. If the email never arrives, check Resend's dashboard logs before touching any code: a rejected send appears there with a reason, and it is almost always a DNS record still set to proxied.

- [ ] **Step 7: Point the reminder cron at the domain**

Plan 3 Task 10 Step 9 already installed `/etc/cron.d/party-reminders` against `https://wazup.party`. Confirm it works now that the name resolves:

```bash
. /opt/party/.env.cron && curl -sS -X POST \
  -H "Authorization: Bearer $CRON_SECRET" https://wazup.party/api/cron/reminders
# Expect: {"listings":N,...}
```

And confirm it is unreachable without the secret from outside:

```bash
curl -sI -X POST https://wazup.party/api/cron/reminders | head -1
# Expect: HTTP/2 401
```

- [ ] **Step 8: Retire the known limitation from the docs**

In `README.md`, replace the whole `### Known limitation: email` section with:

```markdown
### Email

`wazup.party` is a verified sending domain in Resend, so magic links and
notifications reach any member. `EMAIL_FROM` is `Party <hello@wazup.party>`.

If deliverability degrades, check Resend's dashboard logs first — a rejected
send is reported there with a reason, and the cause is nearly always a DNS
record that got switched back to proxied in Cloudflare.
```

And replace the `## Production` section's TLS paragraph with:

```markdown
The site is served at https://wazup.party. DNS is on Cloudflare with the
records set to **DNS only** — Caddy holds its own Let's Encrypt certificate,
and Cloudflare's proxy in its default Flexible SSL mode would fight Caddy's
HTTP-to-HTTPS redirect and produce a redirect loop. To enable the proxy, first
set SSL/TLS mode to Full (strict).
```

In `docs/superpowers/specs/2026-07-25-party-table-splitting-design.md`, replace the `sslip.io` sentence in **Architecture → Deployment** and delete the **Known limitation** paragraph that follows it, replacing both with:

```markdown
**Deployment:** a single DigitalOcean Droplet running Docker Compose — Postgres,
the app, and Caddy as a TLS-terminating reverse proxy. The site is served at
`wazup.party`, with DNS on Cloudflare set to DNS-only so Caddy holds the
certificate. `wazup.party` is a verified sending domain in Resend, so magic
links reach any member. Self-hosting Postgres alongside the app rather than
using a managed database is a deliberate cost choice for a personal account,
and it makes nightly `pg_dump` backups the operator's responsibility.
```

A spec that still describes a workaround the product no longer uses is worse than no spec: the next person to read it will reintroduce the workaround.

- [ ] **Step 9: Commit and push**

```bash
git add Caddyfile README.md .env.example docs/superpowers/specs
git commit -m "chore: serve wazup.party with a verified Resend sending domain"
git push
```

---

## Definition of done

- [ ] `npm test`, `npm run test:integration`, `npm run test:e2e`, `npm run lint`, and `npm run build` all pass.
- [ ] `TZ=UTC npm test` and `TZ=America/New_York npm test` produce identical results.
- [ ] No email template renders a UTC time — the `formatEventTime` assertion in `tests/domain/notify/templates.test.ts` covers every one of them.
- [ ] Two dispatches of the same event to the same person send exactly one email, proven by the simultaneous-claim integration test against the real unique constraint.
- [ ] With `RESEND_API_KEY` set to an invalid value, approving a seat still succeeds, logs a `[notify]` error, and writes **no** `email_log` row — so a retry after fixing the key would still send.
- [ ] A guest who marks a seat paid sees "awaiting confirmation", and the host sees "Says paid" with a "Mark received" button.
- [ ] Removing a guest whose payment was confirmed turns their row red, shows the refund banner, and excludes them from "Still to collect".
- [ ] `POST /api/cron/reminders` returns 401 without the secret, 405 on `GET`, and a summary with the secret; a second call the same day reports `sent: 0` with a non-zero `skipped`.
- [ ] `https://wazup.party` serves a valid Let's Encrypt certificate, and `http://` and `www.` both redirect to it.
- [ ] A member who is **not** the Resend account owner has received a magic link at their own address and signed in.
- [ ] Every URL in a received email begins `https://wazup.party`.
- [ ] `grep -rn "new Date(" lib/domain` returns only `event-time.ts`.
- [ ] The README and the design spec no longer mention `sslip.io` or the shared test sender.

## What is deliberately not done

**No admin UI.** Suspending a member, replenishing spent invite codes, and merging duplicate venues remain direct database operations, as the spec intends. The recipient queries all filter `status = 'active'`, so suspending someone in psql does stop their email — the one moderation action that needed application support has it.

**No refund workflow.** `refund_owed` is a flag and a banner. The platform never held the money and cannot return it; the honest boundary is to show the host that they owe it.

**No HTML email.** Plain text only, one template per event. A second rendering per email would be a second thing to keep in sync for an audience reading all of this on a lock screen.

**No unmarking or unconfirming a payment.** A host who taps "Mark received" by mistake fixes it in psql. Adding an undo means a second state transition, a second permission check, and a second email to decide about, for a mistake that costs one SQL statement to repair in a community this size.

**No waitlist.** A full table refuses new requests. Pending requests may already outnumber seats, which covers the same need without a second queue to manage.

## The product, end to end

A member holds three invite codes and shares one. The person who redeems it becomes a member and signs in by email — no password, ever. They see a feed of upcoming tables, soonest first, filterable by venue and date, each showing the venue, the night, the price per seat, and how many spots are left in Bali time.

A host who has already booked a table lists the spare seats at a fixed price. Every active member is emailed. Members ask for a seat with an optional note; the host is emailed, approves or declines each one, and cannot oversell the table however many devices they tap on. Approved guests are emailed the amount and the host's own payment link, mark the seat paid when they have, and the host confirms it arrived. The host's grid shows, most urgent first, who still owes and who is owed a refund. The day before, everyone gets one reminder with their own payment status.

Nobody opens WhatsApp to make any of that happen, which is the whole point.
