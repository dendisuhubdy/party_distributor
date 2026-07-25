import { beforeEach, describe, expect, it } from 'vitest'
import { findOrCreateVenue } from '@/lib/domain/tables/venues'
import { DomainError } from '@/lib/domain/errors'
import { FakePartyRepository } from '../../support/fake-party-repository'

const NOW = new Date('2026-08-01T12:00:00Z')

let repository: FakePartyRepository
let memberId: string

const deps = () => ({ repository, now: () => NOW })

beforeEach(() => {
  repository = new FakePartyRepository()
  memberId = repository.seedUser({ name: 'Member' }).id
})

describe('findOrCreateVenue', () => {
  it('creates a venue nobody has listed before', async () => {
    const venue = await findOrCreateVenue(deps(), { name: 'Atlas', city: 'Bali', createdBy: memberId })

    expect(venue.name).toBe('Atlas')
    expect(venue.city).toBe('Bali')
    expect(repository.venues).toHaveLength(1)
  })

  it('reuses an existing venue instead of creating a near-duplicate', async () => {
    const seeded = repository.seedVenue({ name: 'Savaya', city: 'Bali' })

    const venue = await findOrCreateVenue(deps(), { name: 'savaya', city: 'Bali', createdBy: memberId })

    expect(venue.id).toBe(seeded.id)
    expect(repository.venues).toHaveLength(1)
  })

  it('ignores surrounding whitespace when matching', async () => {
    const seeded = repository.seedVenue({ name: 'Miss Fish', city: 'Bali' })

    const venue = await findOrCreateVenue(deps(), { name: '  Miss Fish  ', city: 'Bali', createdBy: memberId })

    expect(venue.id).toBe(seeded.id)
  })

  it('stores the name as typed, not lowercased', async () => {
    const venue = await findOrCreateVenue(deps(), { name: '  Potato Head  ', city: ' Bali ', createdBy: memberId })

    expect(venue.name).toBe('Potato Head')
    expect(venue.city).toBe('Bali')
  })

  it('rejects a blank name or city', async () => {
    for (const input of [
      { name: '   ', city: 'Bali' },
      { name: 'Atlas', city: '  ' },
    ]) {
      await expect(
        findOrCreateVenue(deps(), { ...input, createdBy: memberId }),
        `expected ${JSON.stringify(input)} to be rejected`,
      ).rejects.toBeInstanceOf(DomainError)
    }
  })

  it('rejects a name longer than a venue name plausibly is', async () => {
    await expect(findOrCreateVenue(deps(), {
      name: 'x'.repeat(81), city: 'Bali', createdBy: memberId,
    })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
