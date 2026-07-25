import type { Invite, User } from './types'

export interface NewUser {
  email: string
  name: string
  instagramHandle: string | null
  invitedBy: string
}

export interface MembershipRepository {
  findUserByEmail(email: string): Promise<User | null>
  findInviteByCode(code: string): Promise<Invite | null>
  listInvitesCreatedBy(userId: string): Promise<Invite[]>

  /**
   * Atomically: claim the invite if and only if it is still unredeemed, create
   * the user, and stamp the invite with the new user's id.
   *
   * `redeemedAt` is the authoritative claim marker, not `redeemedBy`. The
   * claim has to happen before the user exists, and `redeemedBy` carries a
   * foreign key to users.id, so it cannot be written first.
   *
   * Returns null if the invite was already claimed — by a concurrent caller or
   * otherwise. Callers MUST treat null as "already redeemed" rather than
   * checking redemption separately, because any check performed before this
   * call is stale by the time it returns.
   */
  claimInviteAndCreateUser(inviteId: string, user: NewUser): Promise<User | null>

  insertInvites(invites: Array<{ code: string; createdBy: string; expiresAt: Date }>): Promise<Invite[]>
}

export interface MembershipDeps {
  repository: MembershipRepository
  now: () => Date
  generateCode?: () => string
}
