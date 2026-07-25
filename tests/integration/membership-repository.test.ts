import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { invites, users } from '@/lib/db/schema'
import { PostgresMembershipRepository } from '@/lib/db/repositories/membership'
import { closeIndependentDbs, independentDb } from '../support/db-clients'
import { seedUser, truncateAll } from '../support/db-helpers'

const repository = new PostgresMembershipRepository(db)

let hostId: string

beforeEach(async () => {
  await truncateAll()
  hostId = (await seedUser({ email: 'host@example.com', name: 'Host' })).id
})

afterAll(closeIndependentDbs)

async function seedInvite(code: string, expiresAt = new Date('2099-01-01T00:00:00Z')) {
  const [invite] = await db.insert(invites).values({ code, createdBy: hostId, expiresAt }).returning()
  return invite
}

describe('PostgresMembershipRepository', () => {
  it('round-trips an invite by code', async () => {
    await seedInvite('ABCD-EFGH')

    const found = await repository.findInviteByCode('ABCD-EFGH')

    expect(found).toMatchObject({ code: 'ABCD-EFGH', createdBy: hostId, redeemedBy: null })
    expect(found!.expiresAt).toBeInstanceOf(Date)
  })

  it('returns null for a code that does not exist', async () => {
    expect(await repository.findInviteByCode('ZZZZ-ZZZZ')).toBeNull()
  })

  it('finds a user by email case-insensitively', async () => {
    await seedUser({ email: 'someone@example.com', name: 'Someone' })

    expect(await repository.findUserByEmail('SomeOne@Example.com')).not.toBeNull()
  })

  it('creates the user and stamps the invite in one atomic step', async () => {
    const invite = await seedInvite('ABCD-EFGH')

    const user = await repository.claimInviteAndCreateUser(invite.id, {
      email: 'new@example.com', name: 'New Member', instagramHandle: '@new', invitedBy: hostId,
    })

    expect(user).not.toBeNull()
    expect(user!.invitedBy).toBe(hostId)
    expect(user!.status).toBe('active')

    const [stored] = await db.select().from(invites).where(eq(invites.id, invite.id))
    expect(stored.redeemedBy).toBe(user!.id)
    expect(stored.redeemedAt).toBeInstanceOf(Date)
  })

  it('returns null when the invite was already claimed', async () => {
    const invite = await seedInvite('ABCD-EFGH')
    await repository.claimInviteAndCreateUser(invite.id, {
      email: 'first@example.com', name: 'First', instagramHandle: null, invitedBy: hostId,
    })

    const second = await repository.claimInviteAndCreateUser(invite.id, {
      email: 'second@example.com', name: 'Second', instagramHandle: null, invitedBy: hostId,
    })

    expect(second).toBeNull()
  })

  it('creates no orphan user when the claim loses', async () => {
    const invite = await seedInvite('ABCD-EFGH')
    await repository.claimInviteAndCreateUser(invite.id, {
      email: 'first@example.com', name: 'First', instagramHandle: null, invitedBy: hostId,
    })

    await repository.claimInviteAndCreateUser(invite.id, {
      email: 'second@example.com', name: 'Second', instagramHandle: null, invitedBy: hostId,
    })

    const orphans = await db.select().from(users).where(eq(users.email, 'second@example.com'))
    expect(orphans).toHaveLength(0)
  })

  it('lets exactly one of two simultaneous redemptions win', async () => {
    const invite = await seedInvite('ABCD-EFGH')

    // Two repositories on independent connections. Sharing one client does not
    // race — postgres.js serialises even transactions onto a single connection,
    // and a check-then-act implementation passes. See tests/support/db-clients.ts.
    const racerA = new PostgresMembershipRepository(independentDb())
    const racerB = new PostgresMembershipRepository(independentDb())

    const results = await Promise.all([
      racerA.claimInviteAndCreateUser(invite.id, {
        email: 'racer-a@example.com', name: 'Racer A', instagramHandle: null, invitedBy: hostId,
      }),
      racerB.claimInviteAndCreateUser(invite.id, {
        email: 'racer-b@example.com', name: 'Racer B', instagramHandle: null, invitedBy: hostId,
      }),
    ])

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)

    const allUsers = await db.select().from(users)
    expect(allUsers.filter((u) => u.email.startsWith('racer-'))).toHaveLength(1)
  })

  it('inserts a batch of invites and returns them', async () => {
    const expiresAt = new Date('2099-01-01T00:00:00Z')

    const created = await repository.insertInvites([
      { code: 'AAAA-AAAA', createdBy: hostId, expiresAt },
      { code: 'BBBB-BBBB', createdBy: hostId, expiresAt },
    ])

    expect(created.map((i) => i.code).sort()).toEqual(['AAAA-AAAA', 'BBBB-BBBB'])
    expect(await repository.listInvitesCreatedBy(hostId)).toHaveLength(2)
  })
})
