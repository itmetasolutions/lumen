import { redirect } from 'next/navigation'
import { getAuth } from '@/server/auth/guard'

export default async function Home() {
  const auth = await getAuth()
  redirect(auth ? '/dashboard' : '/login')
}
