import { describe, expect, it } from 'vitest'
import { formatRupiah, multiplyRupiah, parseRupiah } from '@/lib/domain/money'
import { DomainError } from '@/lib/domain/errors'

describe('formatRupiah', () => {
  it('groups thousands with dots, the Indonesian convention', () => {
    expect(formatRupiah(2_500_000)).toBe('Rp 2.500.000')
    expect(formatRupiah(25_000_000)).toBe('Rp 25.000.000')
  })

  it('formats small and zero amounts without stray separators', () => {
    expect(formatRupiah(0)).toBe('Rp 0')
    expect(formatRupiah(500)).toBe('Rp 500')
    expect(formatRupiah(1_000)).toBe('Rp 1.000')
  })

  it('formats negative amounts with the sign outside the currency symbol', () => {
    expect(formatRupiah(-1_500_000)).toBe('-Rp 1.500.000')
  })

  it('rejects non-integer amounts rather than rounding silently', () => {
    expect(() => formatRupiah(1500.5)).toThrow(DomainError)
  })
})

describe('parseRupiah', () => {
  it('accepts the format it produces, round-tripping exactly', () => {
    expect(parseRupiah('Rp 2.500.000')).toBe(2_500_000)
    expect(parseRupiah(formatRupiah(17_250_000))).toBe(17_250_000)
  })

  it('accepts what a human actually types', () => {
    expect(parseRupiah('2500000')).toBe(2_500_000)
    expect(parseRupiah('2.500.000')).toBe(2_500_000)
    expect(parseRupiah('2,500,000')).toBe(2_500_000)
    expect(parseRupiah('  Rp 2 500 000  ')).toBe(2_500_000)
  })

  it('rejects input that is not a whole amount of rupiah', () => {
    for (const bad of ['', 'Rp', 'abc', '2500.50', '-100', '1e6']) {
      expect(() => parseRupiah(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrow(DomainError)
    }
  })

  it('rejects a decimal rather than silently multiplying it by a hundred', () => {
    // '2500.50' with every separator stripped is 250050. An implementation that
    // strips first and validates afterwards returns that number happily, which
    // is a hundredfold error on the input a person is most likely to type when
    // they mean a fraction.
    expect(() => parseRupiah('2500.50')).toThrow(DomainError)
    // Ambiguous grouping: which separator is the decimal point?
    expect(() => parseRupiah('2.500,000')).toThrow(DomainError)
    // Malformed grouping.
    expect(() => parseRupiah('2.50.000')).toThrow(DomainError)
  })

  it('reports rejection with the invalid_amount code', () => {
    try {
      parseRupiah('abc')
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('invalid_amount')
    }
  })
})

describe('multiplyRupiah', () => {
  it('computes a table total from seat price and seat count', () => {
    expect(multiplyRupiah(2_500_000, 8)).toBe(20_000_000)
    expect(multiplyRupiah(2_500_000, 0)).toBe(0)
  })

  it('rejects a fractional or negative quantity', () => {
    expect(() => multiplyRupiah(2_500_000, 1.5)).toThrow(DomainError)
    expect(() => multiplyRupiah(2_500_000, -1)).toThrow(DomainError)
  })

  it('rejects results beyond safe integer precision instead of losing rupiah', () => {
    expect(() => multiplyRupiah(Number.MAX_SAFE_INTEGER, 2)).toThrow(DomainError)
  })
})
