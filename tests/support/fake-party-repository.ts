import type {
  CancelCascade, FeedRange, ListingPatch, NewListing, TablesRepository,
} from '@/lib/domain/tables/ports'
import type { ListingSummary, TableListing, Venue } from '@/lib/domain/tables/types'
import type {
  ApproveOutcome, NewSeatRequest, SeatListing, SeatsRepository,
} from '@/lib/domain/seats/ports'
import type { HeldSeat, RosterEntry, SeatRequest, SeatRequestStatus } from '@/lib/domain/seats/types'

interface FakeUser { id: string; name: string; instagramHandle: string | null }

let counter = 0
const nextId = (prefix: string) => `${prefix}-${++counter}`

export class FakePartyRepository implements TablesRepository, SeatsRepository {
  users: FakeUser[] = []
  venues: Venue[] = []
  listings: TableListing[] = []
  requests: SeatRequest[] = []

  /** Set by a test to make the next approval report a full table. */
  forceApprovalFull = false

  // ---------- seeding ----------

  seedUser(partial: { name: string; instagramHandle?: string | null } = { name: 'Member' }): FakeUser {
    const user = { id: nextId('user'), name: partial.name, instagramHandle: partial.instagramHandle ?? null }
    this.users.push(user)
    return user
  }

  seedVenue(partial: { name: string; city: string }): Venue {
    const venue = { id: nextId('venue'), name: partial.name, city: partial.city }
    this.venues.push(venue)
    return venue
  }

  seedListing(partial: Partial<TableListing> & { hostId: string }): TableListing {
    const listing: TableListing = {
      id: nextId('listing'),
      hostId: partial.hostId,
      venueId: partial.venueId ?? this.seedVenue({ name: 'Savaya', city: 'Bali' }).id,
      eventName: partial.eventName ?? null,
      startsAt: partial.startsAt ?? new Date('2026-09-01T14:00:00Z'),
      seatsOffered: partial.seatsOffered ?? 4,
      seatPrice: partial.seatPrice ?? 2_500_000,
      tableTotal: partial.tableTotal ?? null,
      notes: partial.notes ?? null,
      paymentLink: partial.paymentLink ?? null,
      paymentNote: partial.paymentNote ?? null,
      status: partial.status ?? 'open',
      cancelledAt: partial.cancelledAt ?? null,
      createdAt: partial.createdAt ?? new Date('2026-08-01T00:00:00Z'),
    }
    this.listings.push(listing)
    return listing
  }

  seedRequest(partial: {
    tableId: string; userId: string; status?: SeatRequestStatus; message?: string | null
  }): SeatRequest {
    const listing = this.listings.find((l) => l.id === partial.tableId)
    const request: SeatRequest = {
      id: nextId('request'),
      tableId: partial.tableId,
      hostId: listing?.hostId ?? 'unknown-host',
      userId: partial.userId,
      message: partial.message ?? null,
      status: partial.status ?? 'pending',
      decidedAt: null,
      decidedBy: null,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    }
    this.requests.push(request)
    return request
  }

  // ---------- TablesRepository ----------

  async listVenues(): Promise<Venue[]> {
    return [...this.venues].sort((a, b) => a.name.localeCompare(b.name))
  }

  async findVenueById(venueId: string): Promise<Venue | null> {
    return this.venues.find((v) => v.id === venueId) ?? null
  }

  async findVenueByName(name: string): Promise<Venue | null> {
    const needle = name.trim().toLowerCase()
    return this.venues.find((v) => v.name.trim().toLowerCase() === needle) ?? null
  }

  async createVenue(input: { name: string; city: string; createdBy: string }): Promise<Venue> {
    return this.seedVenue({ name: input.name, city: input.city })
  }

  async insertListing(listing: NewListing): Promise<TableListing> {
    return this.seedListing(listing)
  }

  async findListingById(listingId: string): Promise<TableListing | null> {
    return this.listings.find((l) => l.id === listingId) ?? null
  }

  private summarize(listing: TableListing): ListingSummary {
    const venue = this.venues.find((v) => v.id === listing.venueId)!
    const host = this.users.find((u) => u.id === listing.hostId)
      ?? { id: listing.hostId, name: 'Host', instagramHandle: null }
    return {
      listing,
      venue,
      host: { id: host.id, name: host.name, instagramHandle: host.instagramHandle },
      approvedSeats: this.requests.filter((r) => r.tableId === listing.id && r.status === 'approved').length,
    }
  }

  async findListingSummary(listingId: string): Promise<ListingSummary | null> {
    const listing = await this.findListingById(listingId)
    return listing ? this.summarize(listing) : null
  }

  async listUpcomingListings(range: FeedRange): Promise<ListingSummary[]> {
    return this.listings
      .filter((l) => l.status === 'open')
      .filter((l) => l.startsAt.getTime() > range.from.getTime())
      .filter((l) => (range.to ? l.startsAt.getTime() < range.to.getTime() : true))
      .filter((l) => (range.venueId ? l.venueId === range.venueId : true))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((l) => this.summarize(l))
  }

  async listListingsHostedBy(userId: string): Promise<ListingSummary[]> {
    return this.listings
      .filter((l) => l.hostId === userId)
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
      .map((l) => this.summarize(l))
  }

  async countApprovedSeats(listingId: string): Promise<number> {
    return this.requests.filter((r) => r.tableId === listingId && r.status === 'approved').length
  }

  async updateListing(listingId: string, patch: ListingPatch): Promise<TableListing> {
    const listing = this.listings.find((l) => l.id === listingId)!
    for (const [key, value] of Object.entries(patch)) {
      // Double-assert through unknown: TableListing has no index signature,
      // so a direct cast is TS2352 ("not sufficiently overlapping").
      if (value !== undefined) (listing as unknown as Record<string, unknown>)[key] = value
    }
    return listing
  }

  async cancelListing(listingId: string, byUserId: string, at: Date): Promise<CancelCascade> {
    const listing = this.listings.find((l) => l.id === listingId)!
    listing.status = 'cancelled'
    listing.cancelledAt = at

    const removedUserIds: string[] = []
    const declinedUserIds: string[] = []

    for (const request of this.requests.filter((r) => r.tableId === listingId)) {
      if (request.status === 'approved') {
        request.status = 'removed'
        removedUserIds.push(request.userId)
      } else if (request.status === 'pending') {
        request.status = 'declined'
        declinedUserIds.push(request.userId)
      } else {
        continue
      }
      request.decidedAt = at
      request.decidedBy = byUserId
    }

    return { listing, removedUserIds, declinedUserIds }
  }

  // ---------- SeatsRepository ----------

  async findListingForSeats(listingId: string): Promise<SeatListing | null> {
    const listing = await this.findListingById(listingId)
    if (!listing) return null
    return {
      id: listing.id,
      hostId: listing.hostId,
      startsAt: listing.startsAt,
      seatsOffered: listing.seatsOffered,
      seatPrice: listing.seatPrice,
      status: listing.status,
    }
  }

  async findActiveRequest(listingId: string, userId: string): Promise<SeatRequest | null> {
    return this.requests.find(
      (r) => r.tableId === listingId && r.userId === userId
        && (r.status === 'pending' || r.status === 'approved'),
    ) ?? null
  }

  async insertRequest(input: NewSeatRequest): Promise<SeatRequest> {
    return this.seedRequest({ tableId: input.tableId, userId: input.userId, message: input.message })
  }

  async findRequestById(requestId: string): Promise<SeatRequest | null> {
    return this.requests.find((r) => r.id === requestId) ?? null
  }

  async listRequestsForListing(listingId: string): Promise<RosterEntry[]> {
    return this.requests
      .filter((r) => r.tableId === listingId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((request) => {
        const user = this.users.find((u) => u.id === request.userId)
          ?? { id: request.userId, name: 'Guest', instagramHandle: null }
        return { request, user }
      })
  }

  async listSeatsHeldBy(userId: string): Promise<HeldSeat[]> {
    return this.requests
      .filter((r) => r.userId === userId && (r.status === 'pending' || r.status === 'approved'))
      .map((request) => ({ request, listing: this.summarize(this.listings.find((l) => l.id === request.tableId)!) }))
      .sort((a, b) => a.listing.listing.startsAt.getTime() - b.listing.listing.startsAt.getTime())
  }

  async approveIfSeatAvailable(requestId: string, decidedBy: string, at: Date): Promise<ApproveOutcome> {
    const request = this.requests.find((r) => r.id === requestId)
    if (!request || request.status !== 'pending') return { ok: false, reason: 'already_decided' }

    const listing = this.listings.find((l) => l.id === request.tableId)!
    const approved = await this.countApprovedSeats(listing.id)

    if (this.forceApprovalFull || approved >= listing.seatsOffered) {
      this.forceApprovalFull = false
      return { ok: false, reason: 'table_full' }
    }

    request.status = 'approved'
    request.decidedAt = at
    request.decidedBy = decidedBy
    return { ok: true, request }
  }

  async setRequestStatus(
    requestId: string, status: SeatRequestStatus, at: Date, decidedBy: string,
  ): Promise<SeatRequest> {
    const request = this.requests.find((r) => r.id === requestId)!
    request.status = status
    request.decidedAt = at
    request.decidedBy = decidedBy
    return request
  }
}
