import type { MembershipRepository, NewUser } from '@/lib/domain/membership/ports'
import type { Invite, User } from '@/lib/domain/membership/types'

let counter = 0
const nextId = (prefix: string) => `${prefix}-${++counter}`

export class FakeMembershipRepository implements MembershipRepository {
  users: User[] = []
  invites: Invite[] = []
  /** Simulates losing the claim race to a concurrent redeemer. */
  failNextClaim = false

  /** Set by tests that assert on redeemedAt. */
  claimTime = new Date('2026-08-01T12:00:00Z')

  seedUser(partial: { email: string; name: string; invitedBy?: string | null }): User {
    const user: User = {
      id: nextId('user'),
      email: partial.email.trim().toLowerCase(),
      name: partial.name,
      instagramHandle: null,
      status: 'active',
      invitedBy: partial.invitedBy ?? null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    this.users.push(user)
    return user
  }

  seedInvite(partial: {
    code: string; createdBy: string; expiresAt: Date
    redeemedBy?: string; redeemedAt?: Date
  }): Invite {
    const invite: Invite = {
      id: nextId('invite'),
      code: partial.code,
      createdBy: partial.createdBy,
      redeemedBy: partial.redeemedBy ?? null,
      redeemedAt: partial.redeemedAt ?? null,
      expiresAt: partial.expiresAt,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    this.invites.push(invite)
    return invite
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null
  }

  async findInviteByCode(code: string): Promise<Invite | null> {
    return this.invites.find((i) => i.code === code) ?? null
  }

  async listInvitesCreatedBy(userId: string): Promise<Invite[]> {
    return this.invites.filter((i) => i.createdBy === userId)
  }

  async claimInviteAndCreateUser(inviteId: string, newUser: NewUser): Promise<User | null> {
    if (this.failNextClaim) {
      this.failNextClaim = false
      return null
    }

    const invite = this.invites.find((i) => i.id === inviteId)
    if (!invite || invite.redeemedAt !== null) return null

    const user = this.seedUser({
      email: newUser.email,
      name: newUser.name,
      invitedBy: newUser.invitedBy,
    })
    user.instagramHandle = newUser.instagramHandle

    invite.redeemedBy = user.id
    invite.redeemedAt = this.claimTime
    return user
  }

  async insertInvites(rows: Array<{ code: string; createdBy: string; expiresAt: Date }>): Promise<Invite[]> {
    return rows.map((row) => this.seedInvite(row))
  }
}
