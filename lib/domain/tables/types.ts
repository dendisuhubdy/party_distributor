import type { Rupiah } from '../money'

export type ListingStatus = 'open' | 'cancelled'

export interface Venue {
  id: string
  name: string
  city: string
}

export interface TableListing {
  id: string
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
  status: ListingStatus
  cancelledAt: Date | null
  createdAt: Date
}

/** The listing plus everything a card or detail page renders, in one round trip. */
export interface ListingSummary {
  listing: TableListing
  venue: Venue
  host: { id: string; name: string; instagramHandle: string | null }
  /**
   * Count of seat requests in the `approved` state. Never stored on the
   * listing — a stored counter drifts and needs a job to maintain it.
   */
  approvedSeats: number
}
