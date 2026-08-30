import { notFound } from 'next/navigation'
import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { JobProgress } from '@/components/discovery/job-progress'

export const metadata = { title: 'Discovery job' }

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const auth = await requireAuth()

  const job = await prisma.discoveryJob.findFirst({
    where: { id, workspaceId: auth.workspaceId },
    select: { id: true, name: true },
  })
  if (!job) notFound()

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <JobProgress jobId={job.id} initialName={job.name} />
    </div>
  )
}
