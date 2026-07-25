/**
 * Every error code the domain layer can produce.
 *
 * Codes are declared up front, including ones no use case throws yet, so that
 * adapters can exhaustively map codes to user-facing copy in one place rather
 * than discovering new codes at runtime.
 */
export type DomainErrorCode =
  // membership
  | 'invite_not_found'
  | 'invite_expired'
  | 'invite_already_redeemed'
  | 'invite_quota_exhausted'
  | 'email_already_registered'
  | 'user_suspended'
  // listings (Plan 2)
  | 'listing_not_found'
  | 'listing_cancelled'
  | 'listing_past'
  | 'listing_locked'
  | 'not_listing_host'
  // seats (Plan 2)
  | 'table_full'
  | 'duplicate_seat_request'
  | 'host_cannot_join_own_table'
  | 'seat_request_not_found'
  | 'seat_request_already_decided'
  // shared
  | 'invalid_amount'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError
}
