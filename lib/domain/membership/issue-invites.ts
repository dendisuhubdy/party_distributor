import { generateInviteCode } from './invite-code'
import type { MembershipDeps } from './ports'
import type { Invite } from './types'

/** Codes each active member holds at once. A deliberate throttle on growth, not a technical limit. */
export const INVITE_QUOTA = 3

export const INVITE_TTL_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface IssueInvitesInput {
  userId: string
}

/**
 * Top a member up to their quota of live, unredeemed codes.
 *
 * Idempotent: calling it repeatedly is safe, so a page render can call it
 * without needing to know whether the member has been topped up before.
 *
 * Redeemed codes are NOT replaced. Growth rate is something to watch
 * deliberately before automating.
 */
export async function issueInvites(deps: MembershipDeps, input: IssueInvitesInput): Promise<Invite[]> {
  const { repository, now, generateCode = generateInviteCode } = deps

  const existing = await repository.listInvitesCreatedBy(input.userId)
  const taken = new Set(existing.map((invite) => invite.code))

  // A code counts against the quota if it has been redeemed OR is still live.
  //
  // Counting only live codes would mean every redemption frees a slot, so a
  // member could invite without limit and the community would grow
  // exponentially — the exact opposite of the throttle this quota exists to be.
  // Only codes that expired unredeemed are forgiven: those are waste, not use.
  const consumed = existing.filter(
    (invite) => invite.redeemedAt !== null || invite.expiresAt.getTime() >= now().getTime(),
  )

  const shortfall = INVITE_QUOTA - consumed.length
  if (shortfall <= 0) return []

  const expiresAt = new Date(now().getTime() + INVITE_TTL_DAYS * MS_PER_DAY)
  const rows: Array<{ code: string; createdBy: string; expiresAt: Date }> = []

  while (rows.length < shortfall) {
    const code = generateCode()
    if (taken.has(code)) continue // Vanishingly rare, but a unique index would reject it.
    taken.add(code)
    rows.push({ code, createdBy: input.userId, expiresAt })
  }

  return repository.insertInvites(rows)
}
