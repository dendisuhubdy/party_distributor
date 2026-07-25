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
  // Enables the composite foreign key on seat_requests.
  unique('table_listings_id_host_key').on(table.id, table.hostId),
])
