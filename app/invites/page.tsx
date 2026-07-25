import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { INVITE_QUOTA, issueInvites } from '@/lib/domain/membership/issue-invites'
import { membershipDeps } from '@/lib/membership-service'
import { CopyButton } from './copy-button'

export default async function InvitesPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  // Idempotent: tops the member up to their quota, or does nothing.
  await issueInvites(membershipDeps, { userId: session.user.id })

  const all = await membershipDeps.repository.listInvitesCreatedBy(session.user.id)
  const now = new Date()
  const live = all.filter((i) => i.redeemedAt === null && i.expiresAt > now)
  const spent = all.filter((i) => i.redeemedAt !== null)

  const host = (await headers()).get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') ? 'http' : 'https'
  const linkFor = (code: string) => `${protocol}://${host}/join?code=${code}`

  return (
    <main className="mx-auto max-w-sm px-6 py-10">
      <h1 className="text-2xl font-semibold">Your invites</h1>
      <p className="mt-2 text-sm text-neutral-500">
        You get {INVITE_QUOTA} codes. Each works once. Used codes aren&apos;t replaced —
        choose carefully.
      </p>

      <ul className="mt-6 flex flex-col gap-3">
        {live.map((invite) => (
          <li key={invite.id} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <div>
              <p className="font-mono text-lg tracking-widest">{invite.code}</p>
              <p className="text-xs text-neutral-500">
                Expires {invite.expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </p>
            </div>
            <CopyButton value={linkFor(invite.code)} label="Copy link" />
          </li>
        ))}
      </ul>

      {live.length === 0 && (
        <p className="mt-6 rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          You&apos;ve used all your invites.
        </p>
      )}

      {spent.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-500">Used</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {spent.map((invite) => (
              <li key={invite.id} className="font-mono text-sm text-neutral-400 line-through">
                {invite.code}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
