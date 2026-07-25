import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// `import 'dotenv/config'` alone reads only `.env`, but the secrets live in
// `.env.local` — that is the file Next.js loads and the one .gitignore keeps
// out of the repo. Earlier entries win, so `.env.local` overrides `.env`.
config({ path: ['.env.local', '.env'] })

export default defineConfig({
  schema: './lib/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
