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
