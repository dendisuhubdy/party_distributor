import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // next-auth does `import ... from 'next/server'`, which only resolves under
    // the Next.js compiler. Plain Node ESM resolution needs the file extension.
    // Required so tests can import a server action, which pulls in lib/auth.
    alias: [{ find: /^next\/server$/, replacement: 'next/server.js' }],
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/support/db-setup.ts'],
    // next-auth is externalized by default, so the `next/server` alias above
    // would never reach it. Inlining lets Vite rewrite the import.
    server: { deps: { inline: [/next-auth/, /@auth\//] } },
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
