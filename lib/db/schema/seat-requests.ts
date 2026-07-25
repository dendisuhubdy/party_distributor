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
