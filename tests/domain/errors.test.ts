import { describe, expect, it } from 'vitest'
import { DomainError, isDomainError } from '@/lib/domain/errors'

describe('DomainError', () => {
  it('carries a machine-readable code alongside the message', () => {
    const error = new DomainError('invite_expired', 'This invite expired on 1 August.')

    expect(error.code).toBe('invite_expired')
    expect(error.message).toBe('This invite expired on 1 August.')
  })

  it('is a real Error, so stack traces and instanceof both work', () => {
    const error = new DomainError('invite_not_found', 'No such code.')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('DomainError')
    expect(error.stack).toBeDefined()
  })

  it('optionally carries structured metadata for the UI to render', () => {
    const error = new DomainError('invite_expired', 'Expired.', { expiredAt: '2026-08-01' })

    expect(error.meta).toEqual({ expiredAt: '2026-08-01' })
  })

  it('narrows unknown values through isDomainError', () => {
    expect(isDomainError(new DomainError('invite_not_found', 'x'))).toBe(true)
    expect(isDomainError(new Error('plain'))).toBe(false)
    expect(isDomainError('not an error')).toBe(false)
    expect(isDomainError(null)).toBe(false)
  })
})
