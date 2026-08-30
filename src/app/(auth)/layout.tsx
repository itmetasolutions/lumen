import { redirect } from 'next/navigation'
import { getAuth } from '@/server/auth/guard'

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Already signed in? There is nothing to do on these pages.
  const auth = await getAuth()
  if (auth) redirect('/dashboard')

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_460px]">
      <div className="relative hidden overflow-hidden bg-fg lg:block">
        <div
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 25% 20%, hsl(243 75% 58%) 0, transparent 45%), radial-gradient(circle at 75% 70%, hsl(205 80% 42%) 0, transparent 45%)',
          }}
        />
        <div className="relative flex h-full flex-col justify-between p-12 text-bg">
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="text-[15px] font-semibold tracking-tight">Lumen</span>
          </div>

          <div className="max-w-md">
            <h1 className="text-[32px] font-semibold leading-[1.15] tracking-tight">
              Find the businesses worth calling — and know exactly why.
            </h1>
            <p className="mt-4 text-[15px] leading-7 opacity-70">
              Discovery across multiple providers, deduplicated into one record per
              business. Every website audited with reproducible evidence. Every
              opportunity traced back to what was actually measured.
            </p>

            <ul className="mt-8 space-y-3 text-[13px] opacity-60">
              {[
                'Provider-independent discovery with geographic tiling',
                'Deterministic SEO, performance, UX and technical audits',
                'Overlapping opportunities — never forced into one bucket',
                'Filtered exports that match the filtered view exactly',
              ].map((line) => (
                <li key={line} className="flex gap-2.5">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-bg/60" />
                  {line}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-2xs opacity-40">
            Uses official provider APIs and permitted public sources. No bot-protection
            evasion, no unsolicited outreach.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  )
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" opacity="0.5" />
      <circle cx="12" cy="12" r="4" fill="currentColor" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
