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
