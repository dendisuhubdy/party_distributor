import { config } from 'dotenv'

// `.env.local` holds the real values; `.env` is a fallback. Earlier entries win.
config({ path: ['.env.local', '.env'] })

// Every integration test must run against the test database. Pointing them at
// the dev database would truncate real local data on the first run.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.')
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
