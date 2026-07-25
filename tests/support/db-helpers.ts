import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'

export async function truncateAll(): Promise<void> {
  await db.execute(sql`
    truncate table
      email_log, seat_payments, seat_requests, table_listings,
      venues, invites, sessions, accounts, verification_tokens, users
    restart identity cascade
  `)
}

export async function seedUser(overrides: Partial<{ email: string; name: string }> = {}) {
  const [user] = await db.insert(users).values({
    email: overrides.email ?? `user-${crypto.randomUUID()}@example.com`,
    name: overrides.name ?? 'Test User',
  }).returning()
  return user
}
