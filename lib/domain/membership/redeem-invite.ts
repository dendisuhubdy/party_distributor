import { DomainError } from '../errors'
import { normalizeInviteCode } from './invite-code'
import type { MembershipDeps } from './ports'
import type { User } from './types'

export interface RedeemInviteInput {
  code: string
  email: string
  name: string
  instagramHandle: string | null
}

export async function redeemInvite(deps: MembershipDeps, input: RedeemInviteInput): Promise<User> {
  const { repository, now } = deps

  const code = normalizeInviteCode(input.code)
  const email = input.email.trim().toLowerCase()
  const name = input.name.trim()

  if (name.length === 0) {
    throw new DomainError('invalid_input', 'Enter your name so hosts know who is asking for a seat.')
  }

  const invite = await repository.findInviteByCode(code)
  if (!invite) {
    throw new DomainError('invite_not_found', "That invite code doesn't look right. Check it and try again.")
  }

  // redeemedAt, not redeemedBy: the claim is stamped on redeemedAt first and
  // redeemedBy is backfilled microseconds later. See MembershipRepository.
  if (invite.redeemedAt !== null) {
    throw new DomainError('invite_already_redeemed', 'That invite has already been used.')
  }

  if (invite.expiresAt.getTime() < now().getTime()) {
    throw new DomainError('invite_expired', 'That invite has expired. Ask for a fresh one.', {
      expiredAt: invite.expiresAt,
    })
  }

  if (await repository.findUserByEmail(email)) {
    throw new DomainError('email_already_registered', 'There is already an account for that email. Sign in instead.')
  }

  const user = await repository.claimInviteAndCreateUser(invite.id, {
    email,
    name,
    instagramHandle: input.instagramHandle?.trim() || null,
    invitedBy: invite.createdBy,
  })

  // The checks above are advisory: they exist to produce good error messages.
  // This is the authoritative one. A null return means another redemption won
  // the race between our check and our claim.
  if (!user) {
    throw new DomainError('invite_already_redeemed', 'That invite has already been used.')
  }

  return user
}
