// Must come first: it populates process.env before lib/db/client is evaluated.
import './load-env'

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { sessions, users } from '@/lib/db/schema'

/**
 * Sign in as an existing member without an inbox.
 *
 * Auth.js is configured with `session: { strategy: 'database' }`, so a session
 * is one row plus one cookie. Writing both directly is the only escape hatch
 * that works: `verification_tokens.token` holds `hashToken(raw)`, not the raw
 * token in the emailed link, so reading it out of the database and putting it
 * in a callback URL is rejected with `error=Verification`.
 *
 * Development only. Nothing imports this, and it is not part of the app.
 */
async function main() {
  const email = (process.argv[2] ?? process.env.FOUNDER_EMAIL ?? '').trim().toLowerCase()
  if (!email) throw new Error('Usage: npm run dev:session -- you@example.com')

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (!user) throw new Error(`No member with email ${email}. Redeem an invite or seed one first.`)
  if (user.status !== 'active') throw new Error(`${email} is ${user.status}, so they cannot sign in.`)

  const sessionToken = randomUUID()
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await db.insert(sessions).values({ sessionToken, userId: user.id, expires })

  console.log(`signed in as ${user.name} <${email}> until ${expires.toISOString()}`)
  console.log()
  console.log('In the browser devtools console on http://localhost:3000:')
  console.log(`  document.cookie = 'authjs.session-token=${sessionToken}; path=/'`)
  console.log()
  console.log('Or with curl:')
  console.log(`  curl -s -H 'Cookie: authjs.session-token=${sessionToken}' http://localhost:3000/`)
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
