import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { invites, users } from '@/lib/db/schema'
import { joinAction } from '@/app/join/actions'
import { seedUser, truncateAll } from '../support/db-helpers'

/**
 * Exercises the server action itself, not just the domain beneath it.
 *
 * The action is the one place where form strings meet the domain, and where a
 * DomainError has to become a rendered message rather than a 500. Its success
 * path ends in `signIn`, which throws a redirect outside a request context — so
 * the success cases assert on the database instead, and the error cases assert
 * on the returned state.
 */

let hostId: string

beforeEach(async () => {
  await truncateAll()
  hostId = (await seedUser({ email: 'host@example.com', name: 'Host' })).id
})

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.append(key, value)
  return data
}

async function seedInvite(code: string, expiresAt = new Date('2099-01-01T00:00:00Z')) {
  const [invite] = await db.insert(invites).values({ code, createdBy: hostId, expiresAt }).returning()
  return invite
}

describe('joinAction error paths', () => {
  it('renders a message for a code that does not exist', async () => {
    const state = await joinAction({}, form({
      code: 'ZZZZ-ZZZZ', name: 'Rina', email: 'rina@example.com', instagramHandle: '',
    }))

    expect(state.error).toMatch(/doesn't look right/i)
  })

  it('renders a message for a malformed code, indistinguishable from a missing one', async () => {
    const state = await joinAction({}, form({
      code: 'nope', name: 'Rina', email: 'rina@example.com', instagramHandle: '',
    }))

    expect(state.error).toMatch(/doesn't look right/i)
  })

  it('renders a message for a code someone already used', async () => {
    const invite = await seedInvite('ABCD-EFGH')
    await db.update(invites)
      .set({ redeemedBy: hostId, redeemedAt: new Date() })
      .where(eq(invites.id, invite.id))

    const state = await joinAction({}, form({
      code: 'ABCD-EFGH', name: 'Rina', email: 'rina@example.com', instagramHandle: '',
    }))

    expect(state.error).toMatch(/already been used/i)
  })

  it('renders a message for an expired code', async () => {
    await seedInvite('ABCD-EFGH', new Date('2020-01-01T00:00:00Z'))

    const state = await joinAction({}, form({
      code: 'ABCD-EFGH', name: 'Rina', email: 'rina@example.com', instagramHandle: '',
    }))

    expect(state.error).toMatch(/expired/i)
  })

  it('renders a message when the email already has an account', async () => {
    await seedInvite('ABCD-EFGH')

    const state = await joinAction({}, form({
      code: 'ABCD-EFGH', name: 'Host Again', email: 'host@example.com', instagramHandle: '',
    }))

    expect(state.error).toMatch(/already an account/i)
  })

  it('renders a message for a blank name', async () => {
    await seedInvite('ABCD-EFGH')

    const state = await joinAction({}, form({
      code: 'ABCD-EFGH', name: '   ', email: 'rina@example.com', instagramHandle: '',
    }))

    expect(state.error).toMatch(/enter your name/i)
  })

  it('creates nothing when it rejects', async () => {
    await seedInvite('ABCD-EFGH')

    await joinAction({}, form({
      code: 'ZZZZ-ZZZZ', name: 'Rina', email: 'rina@example.com', instagramHandle: '',
    }))

    expect(await db.select().from(users).where(eq(users.email, 'rina@example.com'))).toHaveLength(0)
    const [invite] = await db.select().from(invites)
    expect(invite.redeemedAt).toBeNull()
  })
})

describe('joinAction success path', () => {
  it('creates the member, spends the code, and grants their own quota', async () => {
    const invite = await seedInvite('ABCD-EFGH')

    // signIn throws outside a request context. Everything under test has
    // already committed by then, which is exactly the ordering the action
    // relies on: signIn sits outside the try so its redirect is never caught.
    await joinAction({}, form({
      code: 'abcd efgh', name: '  Rina  ', email: '  Rina@Example.COM ', instagramHandle: ' @rina ',
    })).catch(() => undefined)

    const [created] = await db.select().from(users).where(eq(users.email, 'rina@example.com'))
    expect(created).toBeDefined()
    expect(created.name).toBe('Rina')
    expect(created.instagramHandle).toBe('@rina')
    expect(created.invitedBy).toBe(hostId)
    expect(created.status).toBe('active')

    const [spent] = await db.select().from(invites).where(eq(invites.id, invite.id))
    expect(spent.redeemedBy).toBe(created.id)
    expect(spent.redeemedAt).not.toBeNull()

    const theirs = await db.select().from(invites).where(eq(invites.createdBy, created.id))
    expect(theirs).toHaveLength(3)
  })
})
