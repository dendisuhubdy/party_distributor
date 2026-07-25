import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { invites, users } from '../schema'
import type { MembershipRepository, NewUser } from '@/lib/domain/membership/ports'
import type { Invite, User } from '@/lib/domain/membership/types'

type UserRow = typeof users.$inferSelect
type InviteRow = typeof invites.$inferSelect

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    instagramHandle: row.instagramHandle,
    status: row.status,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
  }
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    code: row.code,
    createdBy: row.createdBy,
    redeemedBy: row.redeemedBy,
    redeemedAt: row.redeemedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Db) {}

  async findUserByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users)
      .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
      .limit(1)
    return row ? toUser(row) : null
  }

  async findInviteByCode(code: string): Promise<Invite | null> {
    const [row] = await this.db.select().from(invites).where(eq(invites.code, code)).limit(1)
    return row ? toInvite(row) : null
  }

  async listInvitesCreatedBy(userId: string): Promise<Invite[]> {
    const rows = await this.db.select().from(invites).where(eq(invites.createdBy, userId))
    return rows.map(toInvite)
  }

  async claimInviteAndCreateUser(inviteId: string, newUser: NewUser): Promise<User | null> {
    return this.db.transaction(async (tx) => {
      // Claim first, using redeemedAt. The `isNull(redeemedAt)` predicate makes
      // this a compare-and-set: a concurrent transaction that already claimed
      // the row leaves this UPDATE matching zero rows, so the loser creates no
      // user. redeemedBy cannot be used for the claim because it has a foreign
      // key to users.id and the winning user does not exist yet — it is filled
      // in below, inside the same transaction, so no one observes the gap.
      const claimed = await tx.update(invites)
        .set({ redeemedAt: new Date() })
        .where(and(eq(invites.id, inviteId), isNull(invites.redeemedAt)))
        .returning({ id: invites.id })

      if (claimed.length === 0) return null

      const [created] = await tx.insert(users).values({
        email: newUser.email,
        name: newUser.name,
        instagramHandle: newUser.instagramHandle,
        invitedBy: newUser.invitedBy,
      }).returning()

      await tx.update(invites).set({ redeemedBy: created.id }).where(eq(invites.id, inviteId))

      return toUser(created)
    })
  }

  async insertInvites(rows: Array<{ code: string; createdBy: string; expiresAt: Date }>): Promise<Invite[]> {
    if (rows.length === 0) return []
    const created = await this.db.insert(invites).values(rows).returning()
    return created.map(toInvite)
  }
}
