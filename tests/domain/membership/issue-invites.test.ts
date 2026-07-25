import { beforeEach, describe, expect, it } from 'vitest'
import { INVITE_QUOTA, INVITE_TTL_DAYS, issueInvites } from '@/lib/domain/membership/issue-invites'
import { FakeMembershipRepository } from '../../support/fake-membership-repository'

const NOW = new Date('2026-08-01T12:00:00Z')

let repository: FakeMembershipRepository
let memberId: string

const deps = (overrides: Partial<{ generateCode: () => string }> = {}) => ({
  repository,
  now: () => NOW,
  ...overrides,
})

beforeEach(() => {
  repository = new FakeMembershipRepository()
  memberId = repository.seedUser({ email: 'member@example.com', name: 'Member' }).id
})

describe('issueInvites', () => {
  it('gives a brand-new member their full quota', async () => {
    const invites = await issueInvites(deps(), { userId: memberId })

    expect(invites).toHaveLength(INVITE_QUOTA)
    expect(INVITE_QUOTA).toBe(3)
  })

  it('sets every code to expire after the configured window', async () => {
    const [invite] = await issueInvites(deps(), { userId: memberId })

    const expectedExpiry = new Date(NOW.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)
    expect(invite.expiresAt).toEqual(expectedExpiry)
    expect(INVITE_TTL_DAYS).toBe(30)
  })

  it('is idempotent: a member who already holds their quota gets nothing new', async () => {
    await issueInvites(deps(), { userId: memberId })
    const second = await issueInvites(deps(), { userId: memberId })

    expect(second).toHaveLength(0)
    expect(repository.invites).toHaveLength(INVITE_QUOTA)
  })

  it('tops a member up only to the quota, never past it', async () => {
    repository.seedInvite({ code: 'AAAA-AAAA', createdBy: memberId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const issued = await issueInvites(deps(), { userId: memberId })

    expect(issued).toHaveLength(INVITE_QUOTA - 1)
  })

  it('does not replenish codes that were spent', async () => {
    const guestId = repository.seedUser({ email: 'guest@example.com', name: 'Guest' }).id
    for (let i = 0; i < INVITE_QUOTA; i++) {
      repository.seedInvite({
        code: `AAA${i}-AAAA`, createdBy: memberId,
        expiresAt: new Date('2026-09-01T00:00:00Z'),
        redeemedBy: guestId, redeemedAt: NOW,
      })
    }

    const issued = await issueInvites(deps(), { userId: memberId })

    expect(issued).toHaveLength(0)
  })

  it('does not count expired codes toward the quota', async () => {
    repository.seedInvite({ code: 'AAAA-AAAA', createdBy: memberId, expiresAt: new Date('2026-07-01T00:00:00Z') })

    const issued = await issueInvites(deps(), { userId: memberId })

    expect(issued).toHaveLength(INVITE_QUOTA)
  })

  it('retries when a generated code collides with an existing one', async () => {
    repository.seedInvite({ code: 'DUPE-DUPE', createdBy: memberId, expiresAt: new Date('2026-07-01T00:00:00Z') })

    const sequence = ['DUPE-DUPE', 'AAAA-AAAA', 'BBBB-BBBB', 'CCCC-CCCC']
    let index = 0
    const invites = await issueInvites(deps({ generateCode: () => sequence[index++] }), { userId: memberId })

    expect(invites.map((i) => i.code)).toEqual(['AAAA-AAAA', 'BBBB-BBBB', 'CCCC-CCCC'])
  })
})
