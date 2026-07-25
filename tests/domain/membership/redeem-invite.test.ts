import { beforeEach, describe, expect, it } from 'vitest'
import { redeemInvite } from '@/lib/domain/membership/redeem-invite'
import { DomainError } from '@/lib/domain/errors'
import { FakeMembershipRepository } from '../../support/fake-membership-repository'

const NOW = new Date('2026-08-01T12:00:00Z')
const deps = (repository: FakeMembershipRepository) => ({ repository, now: () => NOW })

let repository: FakeMembershipRepository
let hostId: string

beforeEach(() => {
  repository = new FakeMembershipRepository()
  hostId = repository.seedUser({ email: 'host@example.com', name: 'Host' }).id
})

describe('redeemInvite', () => {
  it('creates an active member linked to whoever invited them', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const user = await redeemInvite(deps(repository), {
      code: 'ABCD-EFGH',
      email: 'new@example.com',
      name: 'New Member',
      instagramHandle: '@newmember',
    })

    expect(user.email).toBe('new@example.com')
    expect(user.name).toBe('New Member')
    expect(user.instagramHandle).toBe('@newmember')
    expect(user.status).toBe('active')
    expect(user.invitedBy).toBe(hostId)
  })

  it('marks the invite as redeemed by the new member', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const user = await redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })

    const invite = await repository.findInviteByCode('ABCD-EFGH')
    expect(invite!.redeemedBy).toBe(user.id)
    expect(invite!.redeemedAt).toEqual(NOW)
  })

  it('accepts a code however the person retyped it', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const user = await redeemInvite(deps(repository), {
      code: '  abcdefgh ', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })

    expect(user.email).toBe('new@example.com')
  })

  it('normalizes the email so casing cannot create a duplicate account', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    const user = await redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: '  New@Example.COM ', name: 'New Member', instagramHandle: null,
    })

    expect(user.email).toBe('new@example.com')
  })

  it('rejects a code that does not exist', async () => {
    await expect(redeemInvite(deps(repository), {
      code: 'ZZZZ-ZZZZ', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'invite_not_found' })
  })

  it('rejects an expired code, and says when it expired', async () => {
    const expiredAt = new Date('2026-07-01T00:00:00Z')
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: expiredAt })

    try {
      await redeemInvite(deps(repository), {
        code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('invite_expired')
      expect((error as DomainError).meta).toEqual({ expiredAt })
    }
  })

  it('treats a code expiring exactly now as still valid', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: NOW })

    const user = await redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })

    expect(user.email).toBe('new@example.com')
  })

  it('rejects a code someone else already used', async () => {
    const otherId = repository.seedUser({ email: 'other@example.com', name: 'Other' }).id
    repository.seedInvite({
      code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z'),
      redeemedBy: otherId, redeemedAt: new Date('2026-07-15T00:00:00Z'),
    })

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'invite_already_redeemed' })
  })

  it('rejects an email that already has an account', async () => {
    repository.seedUser({ email: 'taken@example.com', name: 'Existing' })
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'taken@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'email_already_registered' })
  })

  it('leaves the invite unredeemed when the email is already taken', async () => {
    repository.seedUser({ email: 'taken@example.com', name: 'Existing' })
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'taken@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toThrow()

    const invite = await repository.findInviteByCode('ABCD-EFGH')
    expect(invite!.redeemedBy).toBeNull()
  })

  it('rejects a blank name rather than creating a nameless member', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: '   ', instagramHandle: null,
    })).rejects.toBeInstanceOf(DomainError)
  })

  it('surfaces a lost race as invite_already_redeemed', async () => {
    repository.seedInvite({ code: 'ABCD-EFGH', createdBy: hostId, expiresAt: new Date('2026-09-01T00:00:00Z') })
    repository.failNextClaim = true

    await expect(redeemInvite(deps(repository), {
      code: 'ABCD-EFGH', email: 'new@example.com', name: 'New Member', instagramHandle: null,
    })).rejects.toMatchObject({ code: 'invite_already_redeemed' })
  })
})
