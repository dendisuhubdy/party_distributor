import { DomainError } from './errors'

/**
 * An amount of Indonesian rupiah, always a whole number.
 *
 * The rupiah's nominal subunit (sen) has not circulated for decades and no
 * venue prices in it, so the rupiah itself is the storage unit. Persisted as
 * `bigint` because a large table in sen would overflow a 32-bit integer.
 */
export type Rupiah = number

function assertWholeRupiah(amount: number): void {
  if (!Number.isInteger(amount)) {
    throw new DomainError('invalid_amount', 'Amounts must be a whole number of rupiah.', { amount })
  }
  if (!Number.isSafeInteger(amount)) {
    throw new DomainError('invalid_amount', 'Amount is too large to represent exactly.', { amount })
  }
}

export function formatRupiah(amount: Rupiah): string {
  assertWholeRupiah(amount)

  const sign = amount < 0 ? '-' : ''
  const grouped = Math.abs(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')

  return `${sign}Rp ${grouped}`
}

/** Digits only: `2500000`. */
const PLAIN = /^\d+$/

/**
 * Digits grouped in threes by one consistent separator: `2.500.000`,
 * `2,500,000`, `2 500 000`.
 *
 * The grouping is validated rather than stripped. Stripping every separator
 * first and checking for digits afterwards accepts `2500.50` and returns
 * 250,050 — a hundredfold error, on the one input a person is most likely to
 * type when they mean a fraction. Mixed separators like `2.500,000` are
 * ambiguous and rejected for the same reason.
 */
const GROUPED = /^\d{1,3}(([.,\s])\d{3}(\2\d{3})*)$/

export function parseRupiah(input: string): Rupiah {
  const trimmed = input.trim().replace(/^Rp\s*/i, '').trim()

  let digits: string
  if (PLAIN.test(trimmed)) {
    digits = trimmed
  } else if (GROUPED.test(trimmed)) {
    digits = trimmed.replace(/[.,\s]/g, '')
  } else {
    throw new DomainError('invalid_amount', 'Enter a whole amount in rupiah, for example 2.500.000.', { input })
  }

  const amount = Number(digits)
  assertWholeRupiah(amount)
  return amount
}

export function multiplyRupiah(amount: Rupiah, quantity: number): Rupiah {
  assertWholeRupiah(amount)

  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new DomainError('invalid_amount', 'Quantity must be a whole number of seats, zero or more.', { quantity })
  }

  const total = amount * quantity
  assertWholeRupiah(total)
  return total
}
