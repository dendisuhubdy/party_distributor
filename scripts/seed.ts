// Must come first: `dotenv/config` reads only `.env`, and the secrets live in
// `.env.local`. lib/db/client throws at import time if DATABASE_URL is unset.
import './load-env'

import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { users, venues } from '@/lib/db/schema'
import { issueInvites } from '@/lib/domain/membership/issue-invites'
import { membershipDeps } from '@/lib/membership-service'

const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL
const FOUNDER_NAME = process.env.FOUNDER_NAME ?? 'Founder'

const VENUES = [
  { name: 'Savaya', city: 'Bali' },
  { name: 'Miss Fish', city: 'Bali' },
]

async function main() {
  if (!FOUNDER_EMAIL) throw new Error('FOUNDER_EMAIL is not set')

  // Idempotent: safe to run on every deploy.
  for (const venue of VENUES) {
    const [existing] = await db.select().from(venues).where(eq(venues.name, venue.name)).limit(1)
    if (!existing) {
      await db.insert(venues).values(venue)
      console.log(`seeded venue: ${venue.name}`)
    }
  }

  const email = FOUNDER_EMAIL.trim().toLowerCase()
  let [founder] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  if (!founder) {
    // invitedBy stays null — the founding member is the one account with no inviter.
    ;[founder] = await db.insert(users).values({ email, name: FOUNDER_NAME }).returning()
    console.log(`seeded founder: ${email}`)
  }

  const issued = await issueInvites(membershipDeps, { userId: founder.id })
  console.log(`founder holds their quota; issued ${issued.length} new code(s)`)
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
