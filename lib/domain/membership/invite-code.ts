import { DomainError } from '../errors'

/** Crockford-style alphabet: no I, L, O, 0, or 1, which people confuse when reading a code aloud. */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

const CODE_LENGTH = 8

/**
 * Whitespace, the ASCII hyphen, and the U+2010–U+2015 dash family that iOS and
 * word processors substitute for it. Someone retyping a code from a screenshot
 * will produce any of them.
 */
const SEPARATORS = /[\s‐-―-]/g

export function generateInviteCode(random: () => number = Math.random): string {
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    const index = Math.floor(random() * INVITE_CODE_ALPHABET.length)
    raw += INVITE_CODE_ALPHABET[index]
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

export function normalizeInviteCode(input: string): string {
  const stripped = input.toUpperCase().replace(SEPARATORS, '')

  const isValid =
    stripped.length === CODE_LENGTH &&
    [...stripped].every((char) => INVITE_CODE_ALPHABET.includes(char))

  if (!isValid) {
    // Deliberately identical to the "no such invite" error: the person typing
    // cannot act on the difference, and separating them leaks which codes are
    // well-formed to anyone guessing.
    throw new DomainError('invite_not_found', "That invite code doesn't look right. Check it and try again.")
  }

  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`
}
