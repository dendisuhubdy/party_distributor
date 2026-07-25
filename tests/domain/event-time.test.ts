import { describe, expect, it } from 'vitest'
import {
  formatEventDay, formatEventTime, parseBaliDateTime, parseBaliDay, toBaliDateTimeValue,
} from '@/lib/domain/event-time'
import { DomainError } from '@/lib/domain/errors'

describe('parseBaliDateTime', () => {
  it('reads a datetime-local value as Bali wall-clock time, never the server clock', () => {
    // 22:00 in Bali (UTC+8) is 14:00 UTC the same day.
    expect(parseBaliDateTime('2026-08-15T22:00')).toEqual(new Date('2026-08-15T14:00:00.000Z'))
  })

  it('rolls back across midnight correctly', () => {
    // 01:30 on the 16th in Bali is 17:30 on the 15th UTC.
    expect(parseBaliDateTime('2026-08-16T01:30')).toEqual(new Date('2026-08-15T17:30:00.000Z'))
  })

  it('accepts a value carrying seconds, which some browsers append', () => {
    expect(parseBaliDateTime('2026-08-15T22:00:00')).toEqual(new Date('2026-08-15T14:00:00.000Z'))
  })

  it('rejects anything that is not a datetime-local value', () => {
    for (const bad of ['', '2026-08-15', '15/08/2026 22:00', '2026-08-15T22:00Z', 'tomorrow']) {
      expect(() => parseBaliDateTime(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrow(DomainError)
    }
  })

  it('rejects a date that does not exist', () => {
    expect(() => parseBaliDateTime('2026-02-30T22:00')).toThrow(DomainError)
    expect(() => parseBaliDateTime('2026-13-01T22:00')).toThrow(DomainError)
    expect(() => parseBaliDateTime('2026-08-15T25:00')).toThrow(DomainError)
  })

  it('reports rejection as invalid_input', () => {
    try {
      parseBaliDateTime('nope')
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as DomainError).code).toBe('invalid_input')
    }
  })
})

describe('toBaliDateTimeValue', () => {
  it('is the exact inverse of parseBaliDateTime', () => {
    for (const value of ['2026-08-15T22:00', '2026-08-16T01:30', '2026-01-01T00:00', '2026-12-31T23:59']) {
      expect(toBaliDateTimeValue(parseBaliDateTime(value))).toBe(value)
    }
  })

  it('produces a value an input[type=datetime-local] accepts', () => {
    expect(toBaliDateTimeValue(new Date('2026-08-15T14:00:00.000Z'))).toBe('2026-08-15T22:00')
  })
})

describe('parseBaliDay', () => {
  it('resolves a day to midnight at the start of that day in Bali', () => {
    expect(parseBaliDay('2026-08-15')).toEqual(new Date('2026-08-14T16:00:00.000Z'))
  })

  it('rejects anything that is not a plain day', () => {
    for (const bad of ['', '2026-8-15', '2026-08-15T22:00', 'today']) {
      expect(() => parseBaliDay(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrow(DomainError)
    }
  })
})

describe('formatEventTime', () => {
  it('renders in Bali time regardless of where the server is', () => {
    expect(formatEventTime(new Date('2026-08-15T14:00:00.000Z'))).toBe('Sat 15 Aug, 22:00')
  })

  it('renders midnight as 00:00, not 24:00', () => {
    expect(formatEventTime(new Date('2026-08-15T16:00:00.000Z'))).toBe('Sun 16 Aug, 00:00')
  })

  it('shows a late-night table on the Bali calendar day, not the UTC one', () => {
    // 23:00 Bali on the 15th is still the 15th UTC, but only just.
    expect(formatEventTime(new Date('2026-08-15T15:00:00.000Z'))).toBe('Sat 15 Aug, 23:00')
    // 01:00 Bali on the 16th is 17:00 UTC on the 15th — the UTC day is wrong.
    expect(formatEventTime(new Date('2026-08-15T17:00:00.000Z'))).toBe('Sun 16 Aug, 01:00')
  })
})

describe('formatEventDay', () => {
  it('renders the Bali calendar day without a time', () => {
    expect(formatEventDay(new Date('2026-08-15T17:00:00.000Z'))).toBe('Sun 16 Aug')
  })
})
