import { describe, expect, it } from 'vitest'
import { INVITE_CODE_ALPHABET, generateInviteCode, normalizeInviteCode } from '@/lib/domain/membership/invite-code'
import { DomainError } from '@/lib/domain/errors'

describe('generateInviteCode', () => {
  it('produces a dashed eight-character code', () => {
    expect(generateInviteCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })

  it('never emits characters that are misread when spoken or typed', () => {
    for (const forbidden of ['I', 'L', 'O', '0', '1']) {
      expect(INVITE_CODE_ALPHABET).not.toContain(forbidden)
    }

    const codes = Array.from({ length: 200 }, () => generateInviteCode())
    for (const code of codes) {
      for (const char of code.replace('-', '')) {
        expect(INVITE_CODE_ALPHABET).toContain(char)
      }
    }
  })

  it('is deterministic when given a deterministic source of randomness', () => {
    const alwaysZero = () => 0
    const first = INVITE_CODE_ALPHABET[0]

    expect(generateInviteCode(alwaysZero)).toBe(`${first.repeat(4)}-${first.repeat(4)}`)
  })

  it('does not collide across a realistic number of draws', () => {
    const codes = new Set(Array.from({ length: 5_000 }, () => generateInviteCode()))
    expect(codes.size).toBe(5_000)
  })
})

describe('normalizeInviteCode', () => {
  it('accepts the canonical form unchanged', () => {
    expect(normalizeInviteCode('ABCD-EFGH')).toBe('ABCD-EFGH')
  })

  it('repairs how people actually retype a code', () => {
    expect(normalizeInviteCode('abcd-efgh')).toBe('ABCD-EFGH')
    expect(normalizeInviteCode('ABCDEFGH')).toBe('ABCD-EFGH')
    expect(normalizeInviteCode('  abcd efgh ')).toBe('ABCD-EFGH')
    expect(normalizeInviteCode('ABCD–EFGH')).toBe('ABCD-EFGH') // en dash from iOS autocorrect
  })

  it('rejects anything that cannot be a code', () => {
    for (const bad of ['', 'ABC', 'ABCDEFGHI', 'ABCD-EFG!', 'ABCI-EFGH']) {
      expect(() => normalizeInviteCode(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrow(DomainError)
    }
  })

  it('reports rejection as invite_not_found, not a separate validation error', () => {
    try {
      normalizeInviteCode('nope')
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as DomainError).code).toBe('invite_not_found')
    }
  })
})
