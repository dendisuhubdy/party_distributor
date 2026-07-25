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
