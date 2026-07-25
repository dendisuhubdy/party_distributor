import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'

export default async function HomePage() {
  const session = await auth()
  if (!session?.user) redirect('/login')

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
