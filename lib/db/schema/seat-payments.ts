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
