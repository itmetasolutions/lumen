import { redirect } from 'next/navigation'
import { requireAuth } from '@/server/auth/guard'
import { LiveFloor } from '@/components/crm/live-floor'

export const metadata = { title: 'Live Floor' }
export const dynamic = 'force-dynamic'

/**
 * The calling floor as it is right now.
 *
 * Everything on this page is polled rather than rendered once, so the server
 * component does nothing but check authority — the data arrives from
 * /api/crm/live and keeps arriving.
 */
export default async function FloorPage() {
  const auth = await requireAuth()
  if (auth.role !== 'OWNER' && auth.role !== 'ADMIN') redirect('/dashboard')

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <LiveFloor />
    </div>
  )
}
