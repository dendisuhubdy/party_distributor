import type { Metadata } from 'next'
import { Geist_Mono, Instrument_Serif, Manrope } from 'next/font/google'
import './globals.css'

// Editorial high-contrast serif for display. Carries the whole personality.
const display = Instrument_Serif({
  variable: '--font-display',
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
})

const sans = Manrope({
  variable: '--font-sans-custom',
  subsets: ['latin'],
})

// Tabular figures for money, so columns of rupiah line up.
const mono = Geist_Mono({
  variable: '--font-mono-custom',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'wazup.party — split a club table with people worth sitting with',
  description:
    'A table at a Bali club costs more than one person should pay and exactly what eight people should. wazup.party finds the other seven and keeps track of who paid. Invite only.',
  openGraph: {
    title: 'wazup.party',
    description: 'Split a club table with people worth sitting with. Invite only.',
    url: 'https://wazup.party',
    siteName: 'wazup.party',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      {/* Plan 2 Task 10 mounts <Nav /> here. It renders null when signed out,
          so the landing page stays uncluttered. */}
      <body className={`${display.variable} ${sans.variable} ${mono.variable} antialiased`}>
        {children}
      </body>
    </html>
  )
}
