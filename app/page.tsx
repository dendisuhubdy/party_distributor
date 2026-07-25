import { auth } from '@/lib/auth'
import { Landing } from './landing'

/**
 * `/` is the public front door for anyone signed out, and the member's home
 * once they are in.
 *
 * It deliberately does NOT redirect anonymous visitors to /login any more: an
 * invite-only product still has to explain itself to the person holding a code.
 *
 * Plan 2 replaces the signed-in branch with the real feed. Leave the anonymous
 * branch alone when it does.
 */
export default async function HomePage() {
  const session = await auth()
  if (!session?.user) return <Landing />

  return (
    <main className="mx-auto max-w-sm px-6 py-10">
      <h1 className="text-2xl font-semibold">Tables</h1>
      <p className="mt-2 text-sm text-neutral-500">
        No tables yet. Listings arrive in the next release.
      </p>
      <a href="/invites" className="mt-6 inline-block text-sm underline">
        Your invites
      </a>
    </main>
  )
}
