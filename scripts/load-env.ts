import { config } from 'dotenv'

/**
 * Loads `.env.local`, then `.env` as a fallback. Earlier entries win.
 *
 * This must be its own module, imported *before* anything that reads
 * `process.env` at import time — `lib/db/client.ts` throws if `DATABASE_URL`
 * is unset the moment it is evaluated. Calling `config()` in a script's own
 * module body is too late: ES module bodies run after every import in the
 * graph has already been evaluated. Importing a side-effect module first works
 * because imports are evaluated in declaration order.
 */
config({ path: ['.env.local', '.env'] })
