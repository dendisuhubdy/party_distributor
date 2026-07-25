import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db/client'
import { PostgresMembershipRepository } from '@/lib/db/repositories/membership'
import { issueInvites } from '@/lib/domain/membership/issue-invites'
import { redeemInvite } from '@/lib/domain/membership/redeem-invite'
import { seedUser, truncateAll } from '../support/db-helpers'

const deps = { repository: new PostgresMembershipRepository(db), now: () => new Date() }

beforeEach(truncateAll)

describe('issue then redeem, against real Postgres', () => {
  it('lets a member invite someone who becomes a member with their own codes', async () => {
    const host = await seedUser({ email: 'host@example.com', name: 'Host' })

    const [firstCode] = await issueInvites(deps, { userId: host.id })

    const joiner = await redeemInvite(deps, {
      code: firstCode.code,
      email: 'joiner@example.com',
      name: 'Joiner',
      instagramHandle: '@joiner',
    })

    expect(joiner.invitedBy).toBe(host.id)

    const joinerInvites = await issueInvites(deps, { userId: joiner.id })
    expect(joinerInvites).toHaveLength(3)
  })

  it('refuses to reuse a code that has been redeemed', async () => {
    const host = await seedUser({ email: 'host@example.com', name: 'Host' })
    const [code] = await issueInvites(deps, { userId: host.id })

    await redeemInvite(deps, { code: code.code, email: 'first@example.com', name: 'First', instagramHandle: null })

    await expect(redeemInvite(deps, {
      code: code.code, email: 'second@example.com', name: 'Second', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'invite_already_redeemed' })
  })

  it('leaves the host holding two live codes after one is spent', async () => {
    const host = await seedUser({ email: 'host@example.com', name: 'Host' })
    const [code] = await issueInvites(deps, { userId: host.id })

    await redeemInvite(deps, { code: code.code, email: 'joiner@example.com', name: 'Joiner', instagramHandle: null })

    const topUp = await issueInvites(deps, { userId: host.id })
    expect(topUp).toHaveLength(0) // spent codes are not replenished

    const live = (await deps.repository.listInvitesCreatedBy(host.id)).filter((i) => i.redeemedAt === null)
    expect(live).toHaveLength(2)
  })
})
