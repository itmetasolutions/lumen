/**
 * Seed script — `npm run db:seed`.
 *
 * Creates the first user and workspace so the app is usable immediately after
 * `npm run db:push`. It creates *no* business data: an empty database is the
 * honest starting state, and demo businesses would need the discovery pipeline
 * to run in order to carry real audit evidence anyway.
 *
 * Credentials come from env, with a clearly-marked development default that is
 * printed on creation.
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

async function main() {
  const { prisma } = await import('../src/server/db/client')
  const { hashPassword } = await import('../src/server/auth/password')
  const { DEFAULT_WEIGHTS } = await import('../src/server/scoring/weights')

  const email = (process.env.SEED_EMAIL ?? 'admin@lumen.local').toLowerCase()
  const password = process.env.SEED_PASSWORD ?? 'ChangeMe123!'
  const workspaceName = process.env.SEED_WORKSPACE ?? 'My Workspace'

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    console.log(`[seed] user ${email} already exists — nothing to do`)
    return
  }

  const passwordHash = await hashPassword(password)
  const slug = `${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}-${Math.random().toString(36).slice(2, 7)}`

  const workspace = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, name: 'Admin', passwordHash },
    })
    return tx.workspace.create({
      data: {
        name: workspaceName,
        slug,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
        settings: { create: {} },
        scoringProfiles: {
          create: {
            name: 'Default',
            isDefault: true,
            weights: DEFAULT_WEIGHTS as unknown as object,
          },
        },
      },
    })
  })

  console.log('[seed] created workspace and owner')
  console.log(`       workspace : ${workspace.name} (${workspace.slug})`)
  console.log(`       email     : ${email}`)
  console.log(`       password  : ${password}`)
  if (!process.env.SEED_PASSWORD) {
    console.log('       ^ development default — change it after signing in')
  }
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    const { prisma } = await import('../src/server/db/client')
    await prisma.$disconnect()
  })
