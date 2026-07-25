import NextAuth from 'next-auth'
import Resend from 'next-auth/providers/resend'
import { DrizzleAdapter } from '@auth/drizzle-adapter'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema'

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'database' },
  pages: { signIn: '/login', verifyRequest: '/login?sent=1', error: '/login' },
  providers: [
    // Deliberately the only provider, and deliberately isolated on one line.
    //
    // wazup.party is a verified sending domain in Resend (DKIM, SPF and the
    // return-path MX all present and unproxied in Cloudflare), so links reach
    // any member's inbox rather than only the account owner's.
    //
    // Swapping providers is a one-line change and touches nothing else — for
    // example, Nodemailer against any SMTP mailbox:
    //   Nodemailer({ server: process.env.EMAIL_SERVER!, from: process.env.EMAIL_FROM! })
    Resend({ from: process.env.EMAIL_FROM!, apiKey: process.env.RESEND_API_KEY! }),
  ],
  callbacks: {
    /**
     * The membership gate. Auth.js would otherwise create an account for any
     * email that requests a magic link, which would bypass invite codes
     * entirely. Accounts are created only by redeemInvite; this callback lets
     * in existing, active members and nobody else.
     */
    async signIn({ user }) {
      const email = user.email?.trim().toLowerCase()
      if (!email) return false

      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
      if (!existing) return false
      if (existing.status !== 'active') return false

      return true
    },
    async session({ session, user }) {
      session.user.id = user.id
      return session
    },
  },
})
