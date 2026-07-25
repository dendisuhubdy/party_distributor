'use client'

import { Suspense, useActionState } from 'react'
import { useSearchParams } from 'next/navigation'
import { joinAction, type JoinFormState } from './actions'

const inputClass =
  'rounded-lg border border-neutral-300 px-4 py-3 text-base dark:border-neutral-700 dark:bg-neutral-950'

export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinForm />
    </Suspense>
  )
}

function JoinForm() {
  const params = useSearchParams()
  const [state, formAction, pending] = useActionState<JoinFormState, FormData>(joinAction, {})

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">You&apos;re invited</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Enter your invite code and a few details. We&apos;ll email you a sign-in link.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        <input
          name="code" required placeholder="ABCD-EFGH" autoCapitalize="characters"
          defaultValue={params.get('code') ?? ''} className={`${inputClass} font-mono tracking-widest`}
        />
        <input name="name" required placeholder="Your name" autoComplete="name" className={inputClass} />
        <input name="email" type="email" required placeholder="you@example.com" autoComplete="email" className={inputClass} />
        <input name="instagramHandle" placeholder="@instagram (optional)" autoCapitalize="none" className={inputClass} />

        {state.error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {state.error}
          </p>
        )}

        <button
          type="submit" disabled={pending}
          className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? 'Joining…' : 'Join'}
        </button>
      </form>

      <p className="text-sm text-neutral-500">
        Already a member? <a href="/login" className="underline">Sign in</a>.
      </p>
    </main>
  )
}
