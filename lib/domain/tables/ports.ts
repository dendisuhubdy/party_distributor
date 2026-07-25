import type { ListingStatus, ListingSummary, TableListing, Venue } from './types'
import type { Rupiah } from '../money'

export interface NewListing {
  hostId: string
  venueId: string
  eventName: string | null
  startsAt: Date
  seatsOffered: number
  seatPrice: Rupiah
  tableTotal: Rupiah | null
  notes: string | null
  paymentLink: string | null
  paymentNote: string | null
}

/** Only the fields a host may change. Absent keys are left alone. */
export interface ListingPatch {
  eventName?: string | null
  notes?: string | null
  paymentLink?: string | null
  paymentNote?: string | null
  seatsOffered?: number
  seatPrice?: Rupiah
  startsAt?: Date
}

export interface FeedRange {
  from: Date
  to?: Date
  venueId?: string
}

export interface CancelCascade {
  listing: TableListing
  /** Guests who held an approved seat. Plan 3 emails them; some may be owed a refund. */
  removedUserIds: string[]
  /** Guests whose request was still pending. Plan 3 emails them too, with softer copy. */
  declinedUserIds: string[]
}

export interface TablesRepository {
  listVenues(): Promise<Venue[]>
  findVenueById(venueId: string): Promise<Venue | null>
  /** Case-insensitive, so "savaya" does not create a second Savaya. */
  findVenueByName(name: string): Promise<Venue | null>
  createVenue(input: { name: string; city: string; createdBy: string }): Promise<Venue>

  insertListing(listing: NewListing): Promise<TableListing>
  findListingById(listingId: string): Promise<TableListing | null>
  findListingSummary(listingId: string): Promise<ListingSummary | null>
  /** Open, not-yet-started listings inside the range, soonest first. Full ones included. */
  listUpcomingListings(range: FeedRange): Promise<ListingSummary[]>
  /** Everything this member has ever hosted, newest event first. */
  listListingsHostedBy(userId: string): Promise<ListingSummary[]>
  countApprovedSeats(listingId: string): Promise<number>

  updateListing(listingId: string, patch: ListingPatch): Promise<TableListing>

  /**
   * Cancel the listing and settle every live seat request in one transaction:
   * `approved` becomes `removed`, `pending` becomes `declined`.
   *
   * The spec describes only the approved cascade. Pending requests must go
   * somewhere or they linger forever against a dead table — visible on the
   * host's manage page and blocking the partial unique index that would let
   * that guest ask again if the host relists.
   */
  cancelListing(listingId: string, byUserId: string, at: Date): Promise<CancelCascade>
}

export interface TablesDeps {
  repository: TablesRepository
  now: () => Date
}

export type { ListingStatus }
