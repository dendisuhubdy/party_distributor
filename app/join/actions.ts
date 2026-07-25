'use server'

import { signIn } from '@/lib/auth'
import { isDomainError } from '@/lib/domain/errors'
import { issueInvites } from '@/lib/domain/membership/issue-invites'
import { redeemInvite } from '@/lib/domain/membership/redeem-invite'
import { membershipDeps } from '@/lib/membership-service'

export interface JoinFormState {
  error?: string
}

export async function joinAction(_prev: JoinFormState, formData: FormData): Promise<JoinFormState> {
  const email = String(formData.get('email') ?? '')

  try {
    const user = await redeemInvite(membershipDeps, {
      code: String(formData.get('code') ?? ''),
      email,
      name: String(formData.get('name') ?? ''),
      instagramHandle: String(formData.get('instagramHandle') ?? '') || null,
    })

    await issueInvites(membershipDeps, { userId: user.id })
  } catch (error) {
    if (isDomainError(error)) return { error: error.message }
    throw error
  }

  // Outside the try: signIn redirects by throwing, and catching that would
  // turn a successful sign-in into a rendered error.
  await signIn('resend', { email: email.trim().toLowerCase(), redirectTo: '/' })
  return {}
}
