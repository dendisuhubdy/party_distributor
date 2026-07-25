import { signIn } from '@/lib/auth'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>
}) {
  const { sent } = await searchParams

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-neutral-500">
          We&apos;ll email you a link. No password to remember.
        </p>
      </div>

      {sent ? (
        <p className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          Check your email for the sign-in link.
        </p>
      ) : (
        <form
          className="flex flex-col gap-3"
          action={async (formData) => {
            'use server'
            await signIn('resend', {
              email: String(formData.get('email')),
              redirectTo: '/',
            })
          }}
        >
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className="rounded-lg border border-neutral-300 px-4 py-3 text-base dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button type="submit" className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white dark:bg-white dark:text-neutral-900">
            Email me a link
          </button>
        </form>
      )}

      <p className="text-sm text-neutral-500">
        Got an invite code? <a href="/join" className="underline">Redeem it here</a>.
      </p>
    </main>
  )
}
