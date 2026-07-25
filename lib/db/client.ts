import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

// Next.js dev mode re-evaluates modules on every hot reload; without this the
// process leaks a connection pool per reload until Postgres refuses new ones.
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> }

const client = globalForDb.pgClient ?? postgres(connectionString, { max: 10 })
if (process.env.NODE_ENV !== 'production') globalForDb.pgClient = client

export const db = drizzle(client, { schema })
export type Db = typeof db
