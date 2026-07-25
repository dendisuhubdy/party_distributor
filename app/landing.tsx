import { formatRupiah } from '@/lib/domain/money'

/**
 * The public front door.
 *
 * The hero is the arithmetic, because the arithmetic *is* the problem: a number
 * that is absurd for one person and unremarkable for eight.
 *
 * The figures run through the same `formatRupiah` the app uses, so the
 * separators cannot drift from the product — and because it rejects fractional
 * rupiah, editing SEATS to something that does not divide TOTAL evenly fails
 * the build instead of quietly rendering a wrong price.
 */
const TOTAL = 25_000_000
const SEATS = 8
const PER_SEAT = TOTAL / SEATS

const NOW = [
  {
    n: '01',
    head: 'Someone commits',
    body: 'One person puts their name on a table with a minimum spend, before anyone has agreed to share it.',
  },
  {
    n: '02',
    head: 'Then the scramble',
    body: 'Four group chats, a dozen maybes, two people who drop out at 9pm, and a stranger nobody wanted at the table.',
  },
  {
    n: '03',
    head: 'And the accounting',
    body: 'Who transferred, who said they would, who is going to be reminded three times. Tracked in one person’s head.',
  },
]

const INSTEAD = [
  {
    head: 'Book the table first',
    body: 'You already have it. No thresholds to hit, no rally that might not happen, nothing to dissolve.',
  },
  {
    head: 'List the spare seats',
    body: 'One fixed price per seat. Everyone knows their cost before they ask for a place.',
  },
  {
    head: 'Approve who joins',
    body: 'Requests come to you with a name and a note. It is your table, so it is your call.',
  },
  {
    head: 'See who has paid',
    body: 'A grid that says paid, said-they-paid, or still owes. No spreadsheet, no reminding people twice.',
  },
]

export function Landing() {
  return (
    <div className="landing grain min-h-dvh font-sans">
      <div className="landing-glow">
        <div className="mx-auto max-w-5xl px-6 pb-24 pt-8 sm:px-10">
          {/* wordmark */}
          <header className="rise flex items-baseline justify-between gap-4">
            <span className="font-display text-xl tracking-tight text-paper">wazup.party</span>
            <span className="text-[0.7rem] uppercase tracking-[0.18em] text-paper-dim">
              Bali · invite only
            </span>
          </header>

          {/* ------------------------------- hero ------------------------------- */}
          <section className="pt-20 sm:pt-28">
            <p
              className="rise text-[0.7rem] uppercase tracking-[0.22em] text-ember"
              style={{ animationDelay: '80ms' }}
            >
              The problem, stated plainly
            </p>

            <h1
              className="rise mt-6 font-display text-4xl leading-[1.05] tracking-tight text-paper sm:text-6xl"
              style={{ animationDelay: '160ms' }}
            >
              A table at Savaya is{' '}
              <span className="whitespace-nowrap font-mono text-3xl tabular-nums sm:text-5xl">
                {formatRupiah(TOTAL)}
              </span>
              .
            </h1>

            {/* the division, drawn */}
            <div className="mt-10 max-w-xl">
              <div
                className="rise flex items-baseline justify-between gap-4 text-paper-dim"
                style={{ animationDelay: '300ms' }}
              >
                <span className="font-display text-2xl italic sm:text-3xl">divided by</span>
                <span className="font-mono text-2xl tabular-nums sm:text-3xl">{SEATS} seats</span>
              </div>

              <div
                className="rule mt-5 h-px w-full bg-linear-to-r from-ember via-ember-deep to-transparent"
                style={{ animationDelay: '460ms' }}
              />

              {/* nowrap and 2.5rem on mobile: at 390px, 12 mono characters at
                  text-5xl overflow 342px of content width and the figure breaks
                  across two lines, which reads as two numbers. */}
              <p
                className="ember-rise mt-6 whitespace-nowrap font-mono text-[2.5rem] tabular-nums leading-none text-ember sm:text-7xl"
                style={{ animationDelay: '620ms' }}
              >
                {formatRupiah(PER_SEAT)}
              </p>
              <p
                className="rise mt-3 font-display text-2xl italic text-sand sm:text-3xl"
                style={{ animationDelay: '760ms' }}
              >
                which is just a night out.
              </p>
            </div>

            <p
              className="rise mt-14 max-w-xl text-base leading-relaxed text-paper-dim"
              style={{ animationDelay: '860ms' }}
            >
              The money was never really the problem. Finding the other seven people — and
              remembering which of them actually paid — is the problem.
              <span className="text-paper"> That is the whole of what this does.</span>
            </p>

            <div
              className="rise mt-10 flex flex-wrap items-center gap-3"
              style={{ animationDelay: '960ms' }}
            >
              <a
                href="/join"
                className="rounded-full bg-paper px-6 py-3.5 text-sm font-semibold text-ink transition-transform hover:-translate-y-0.5"
              >
                I have an invite code
              </a>
              <a
                href="/login"
                className="rounded-full border border-paper-dim/40 px-6 py-3.5 text-sm font-medium text-paper transition-colors hover:border-paper"
              >
                Sign in
              </a>
            </div>
          </section>

          {/* ------------------------- how it goes now ------------------------- */}
          <section className="mt-24 sm:mt-36">
            <h2 className="font-display text-3xl tracking-tight text-paper sm:text-4xl">
              How it goes without this
            </h2>

            <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl border hairline sm:grid-cols-3">
              {NOW.map((step) => (
                <li key={step.n} className="bg-ink-raised p-7">
                  <span className="font-mono text-xs tabular-nums text-ember">{step.n}</span>
                  <h3 className="mt-4 font-display text-2xl text-paper">{step.head}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-paper-dim">{step.body}</p>
                </li>
              ))}
            </ol>

            <p className="mt-8 max-w-2xl font-display text-2xl italic leading-snug text-sand sm:text-3xl">
              Padel courts got solved years ago. Club tables are the same maths and none of the
              software.
            </p>
          </section>

          {/* -------------------------- how it goes here ----------------------- */}
          <section className="mt-24 sm:mt-36">
            <h2 className="font-display text-3xl tracking-tight text-paper sm:text-4xl">
              How it goes here
            </h2>

            <div className="mt-12 flex flex-col">
              {INSTEAD.map((step, i) => (
                <div
                  key={step.head}
                  className="grid gap-2 border-t hairline py-7 sm:grid-cols-[4rem_1fr_1.2fr] sm:gap-8"
                >
                  <span className="font-mono text-sm tabular-nums text-ember">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="font-display text-2xl leading-tight text-paper">{step.head}</h3>
                  <p className="text-sm leading-relaxed text-paper-dim">{step.body}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ----------------------------- boundaries -------------------------- */}
          <section className="mt-24 grid gap-6 sm:mt-36 sm:grid-cols-2">
            <div className="rounded-2xl border hairline bg-ink-raised p-8">
              <h3 className="font-display text-2xl text-paper">It stays small on purpose</h3>
              <p className="mt-3 text-sm leading-relaxed text-paper-dim">
                There is no public sign-up. Every member holds three invite codes, each good once,
                and spent codes are not replaced. That is a deliberate ceiling on how fast this
                grows — the point is a table you would actually want to sit at.
              </p>
            </div>

            <div className="rounded-2xl border hairline bg-ink-raised p-8">
              <h3 className="font-display text-2xl text-paper">It never touches your money</h3>
              <p className="mt-3 text-sm leading-relaxed text-paper-dim">
                No wallet, no escrow, no processing fee. The host attaches their own payment link
                or QR, and this records two things: that you say you paid, and that they say it
                arrived. Where those disagree, it shows you. It cannot move funds, so it does not
                pretend to.
              </p>
            </div>
          </section>

          {/* ------------------------------- close ---------------------------- */}
          <section className="mt-32 border-t hairline pt-14 sm:mt-44">
            <h2 className="max-w-2xl font-display text-3xl leading-tight tracking-tight text-paper sm:text-5xl">
              Got a code from someone? That is the only way in.
            </h2>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href="/join"
                className="rounded-full bg-ember px-6 py-3.5 text-sm font-semibold text-ink transition-transform hover:-translate-y-0.5"
              >
                Redeem an invite
              </a>
              <a
                href="/login"
                className="rounded-full border border-paper-dim/40 px-6 py-3.5 text-sm font-medium text-paper transition-colors hover:border-paper"
              >
                Already a member
              </a>
            </div>

            <p className="mt-12 max-w-xl text-xs leading-relaxed text-paper-dim">
              Live today: invites, accounts and passwordless sign-in. Table listings, seat requests
              and the payment grid are being built now — described above as they are being shipped,
              not as they already are.
            </p>
          </section>

          <footer className="mt-20 flex flex-wrap items-baseline justify-between gap-3 border-t hairline pt-8">
            <span className="font-display text-lg text-paper">wazup.party</span>
            <span className="text-xs text-paper-dim">
              Savaya, Miss Fish, and wherever you have the table. Bali, UTC+8.
            </span>
          </footer>
        </div>
      </div>
    </div>
  )
}
