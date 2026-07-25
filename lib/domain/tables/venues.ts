import { DomainError } from '../errors'
import type { TablesDeps } from './ports'
import type { Venue } from './types'

export const MAX_VENUE_NAME_LENGTH = 80

export interface FindOrCreateVenueInput {
  name: string
  city: string
  createdBy: string
}

/**
 * Resolve a typed venue name to a row, creating it only if nothing matches.
 *
 * Matching is case-insensitive and whitespace-insensitive because members will
 * type "savaya", "Savaya " and "SAVAYA" for the same club, and a feed filtered
 * by venue is useless once the same place exists three times. There is no admin
 * UI to merge duplicates in v1, so the cheap guard here is the only guard.
 */
export async function findOrCreateVenue(deps: TablesDeps, input: FindOrCreateVenueInput): Promise<Venue> {
  const name = input.name.trim()
  const city = input.city.trim()

  if (name.length === 0 || city.length === 0) {
    throw new DomainError('invalid_input', 'A venue needs a name and a city.')
  }
  if (name.length > MAX_VENUE_NAME_LENGTH) {
    throw new DomainError('invalid_input', `Venue names are at most ${MAX_VENUE_NAME_LENGTH} characters.`)
  }

  const existing = await deps.repository.findVenueByName(name)
  if (existing) return existing

  return deps.repository.createVenue({ name, city, createdBy: input.createdBy })
}
