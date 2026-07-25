import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/lib/db/schema'

const opened: Array<ReturnType<typeof postgres>> = []

/**
 * A Drizzle client on its own postgres.js pool.
 *
 * Required by any test that must exercise real contention. postgres.js
 * pipelines work from a single client onto one connection in FIFO order — and
 * that includes transactions, even with `max: 10`. So `Promise.all` over one
 * client does NOT race: the second transaction's BEGIN is not sent until the
 * first has finished, and a check-then-act implementation passes a concurrency
 * test it should fail.
 *
 * Separate clients mean separate sockets, which is the only way two statements
 * genuinely overlap. Verified by observing a naive check-then-act produce two
 * winners here, and exactly one when sharing a client.
 */
export function independentDb() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')

  const client = postgres(url, { max: 1 })
  opened.push(client)
  return drizzle(client, { schema })
}

/** Call from afterAll, or Vitest hangs waiting on the open sockets. */
export async function closeIndependentDbs(): Promise<void> {
  await Promise.all(opened.splice(0).map((client) => client.end()))
}
