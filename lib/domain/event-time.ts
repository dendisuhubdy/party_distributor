import { DomainError } from './errors'

/**
 * Bali is WITA, UTC+8, all year. Indonesia has never observed daylight saving,
 * so a fixed offset is correct rather than merely convenient. If a venue in
 * another timezone is ever added, this constant becomes a per-venue column and
 * every function here takes the venue's zone — that is the intended seam.
 */
export const BALI_UTC_OFFSET_HOURS = 8

const BALI_TIME_ZONE = 'Asia/Makassar'

const DATETIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

function toUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day, hour - BALI_UTC_OFFSET_HOURS, minute))

  // Date.UTC silently rolls 30 February into 2 March. Round-tripping the day
  // fields catches that, and catches an hour of 25 the same way.
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute
  ) {
    throw new DomainError('invalid_input', 'That is not a real date and time.')
  }

  return date
}

/**
 * Read an `<input type="datetime-local">` value as Bali wall-clock time.
 *
 * `new Date('2026-08-15T22:00')` is NOT equivalent: it resolves against the
 * running process's timezone, which is UTC inside the production container. A
 * host typing 22:00 would get a table starting at 06:00 the next morning, and
 * the bug would be invisible on a laptop set to Bali time.
 */
export function parseBaliDateTime(value: string): Date {
  const match = DATETIME_LOCAL.exec(value.trim())
  if (!match) {
    throw new DomainError('invalid_input', 'Pick a date and time for the table.')
  }
  const [, year, month, day, hour, minute] = match
  return toUtc(Number(year), Number(month), Number(day), Number(hour), Number(minute))
}

/** The inverse, for prefilling a datetime-local input from a stored listing. */
export function toBaliDateTimeValue(date: Date): string {
  const shifted = new Date(date.getTime() + BALI_UTC_OFFSET_HOURS * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 16)
}

/** Midnight at the start of a `YYYY-MM-DD` day in Bali. Used by the feed's date filter. */
export function parseBaliDay(value: string): Date {
  const match = DAY.exec(value.trim())
  if (!match) {
    throw new DomainError('invalid_input', 'Pick a date.')
  }
  const [, year, month, day] = match
  return toUtc(Number(year), Number(month), Number(day), 0, 0)
}

function parts(date: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const formatted = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: BALI_TIME_ZONE })
    .formatToParts(date)
  return Object.fromEntries(formatted.map((part) => [part.type, part.value]))
}

/**
 * Assembled from formatToParts rather than returned by format() because the
 * separators Intl chooses vary between ICU versions, which would make these
 * strings — and their tests — unstable across Node upgrades.
 */
export function formatEventTime(date: Date): string {
  const p = parts(date, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`
}

export function formatEventDay(date: Date): string {
  const p = parts(date, { weekday: 'short', day: 'numeric', month: 'short' })
  return `${p.weekday} ${p.day} ${p.month}`
}
