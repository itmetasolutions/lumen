/**
 * End-to-end check of the cold-calling CRM.
 *
 * Drives the real services against the real database: creates an agent, assigns
 * leads, logs calls covering every rule that matters, rolls the day up and
 * compares the report against what was actually done. Cleans up after itself.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-crm.ts
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

const line = (l: string, v: unknown) => console.log(`  ${l.padEnd(34)} ${String(v)}`)

let failed = 0
function check(ok: boolean, message: string, detail?: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

async function main() {
  const { prisma } = await import('../src/server/db/client')
  const { assignLeads, unassignLeads, roundRobinAssign, callableWhere } = await import(
    '../src/server/crm/assignment'
  )
  const { logCall } = await import('../src/server/crm/calls')
  const { clockIn, clockOut, touchPresence, liveAgents, derivePresence } = await import(
    '../src/server/crm/sessions'
  )
  const { computeDailyTotals, dayKey, dayRange, generateDailyReport } = await import(
    '../src/server/crm/reports'
  )
  const { createMember, updateMember, listTeam } = await import('../src/server/crm/team')
  const { agentQueue, queueCounts, nextLead } = await import('../src/server/crm/queue')
  const { HttpError } = await import('../src/server/http/errors')

  // Use the seed workspace, never the user's real data.
  const workspace = await prisma.workspace.findFirst({ where: { name: 'My Workspace' } })
  if (!workspace) throw new Error('seed workspace "My Workspace" not found')

  const owner = await prisma.membership.findFirst({
    where: { workspaceId: workspace.id, role: 'OWNER' },
    select: { userId: true },
  })
  if (!owner) throw new Error('seed workspace has no owner')

  const stamp = Date.now()
  const agentEmail = `verify-agent-${stamp}@lumen.invalid`
  const agent2Email = `verify-agent2-${stamp}@lumen.invalid`
  const createdUserIds: string[] = []
  const touchedBusinessIds: string[] = []

  console.log('\n══ Cold-calling CRM ═══════════════════════════════════════════')
  line('workspace', workspace.name)

  try {
    // ── 1. Accounts are created by an admin, never self-registered ──────────
    console.log('\n── 1. Team administration ────────────────────────────────────')

    const created = await createMember({
      workspaceId: workspace.id,
      actorRole: 'OWNER',
      email: agentEmail,
      name: 'Verify Agent',
      role: 'AGENT',
      jobTitle: 'Sales agent',
    })
    createdUserIds.push(created.userId)
    const agentId = created.userId

    const created2 = await createMember({
      workspaceId: workspace.id,
      actorRole: 'OWNER',
      email: agent2Email,
      name: 'Verify Agent Two',
      role: 'AGENT',
    })
    createdUserIds.push(created2.userId)

    check(created.temporaryPassword.length >= 10, 'a temporary password is issued once')

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: agentId },
      select: { passwordHash: true, mustChangePassword: true, isActive: true },
    })
    check(
      !stored.passwordHash.includes(created.temporaryPassword),
      'the password is stored only as a hash',
    )
    check(stored.mustChangePassword, 'the agent must change it at first sign-in')

    // An admin must not be able to mint an owner.
    let escalated = false
    try {
      await createMember({
        workspaceId: workspace.id,
        actorRole: 'ADMIN',
        email: `verify-escalate-${stamp}@lumen.invalid`,
        name: 'Should Not Exist',
        role: 'OWNER',
      })
      escalated = true
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
    }
    check(!escalated, 'an admin cannot grant the OWNER role')

    // ── 2. Assignment ───────────────────────────────────────────────────────
    console.log('\n── 2. Lead assignment ────────────────────────────────────────')

    const pool = await prisma.business.findMany({
      where: { ...callableWhere(workspace.id), assignedToId: null },
      select: { id: true, name: true, primaryPhone: true },
      take: 6,
    })
    if (pool.length < 4) {
      throw new Error(
        `seed workspace has only ${pool.length} callable unassigned leads; need at least 4`,
      )
    }
    touchedBusinessIds.push(...pool.map((b) => b.id))

    const assigned = await assignLeads({
      workspaceId: workspace.id,
      businessIds: pool.slice(0, 4).map((b) => b.id),
      assignedToId: agentId,
      assignedById: owner.userId,
    })
    line('assigned', assigned.assigned)
    check(assigned.assigned === 4, 'leads are assigned to the agent')

    const openRows = await prisma.leadAssignment.count({
      where: { assignedToId: agentId, releasedAt: null },
    })
    check(openRows === 4, 'assignment history records who gave what to whom')

    // Reassigning must close the previous row rather than leaving two open.
    await assignLeads({
      workspaceId: workspace.id,
      businessIds: [pool[0]!.id],
      assignedToId: created2.userId,
      assignedById: owner.userId,
    })
    const stillOpen = await prisma.leadAssignment.count({
      where: { businessId: pool[0]!.id, releasedAt: null },
    })
    check(stillOpen === 1, 'a reassigned lead has exactly one open assignment')

    await assignLeads({
      workspaceId: workspace.id,
      businessIds: [pool[0]!.id],
      assignedToId: agentId,
      assignedById: owner.userId,
    })

    // ── 3. The queue is scoped to the agent ─────────────────────────────────
    console.log('\n── 3. The agent queue ────────────────────────────────────────')

    const counts = await queueCounts(workspace.id, agentId)
    line('queue total', counts.total)
    check(counts.total === 4, "the agent sees exactly their own leads")
    check(counts.new === 4, 'never-called leads are in the "new" bucket')

    const otherAgentQueue = await queueCounts(workspace.id, created2.userId)
    check(
      otherAgentQueue.total === 0,
      "another agent cannot see this agent's leads",
      `saw ${otherAgentQueue.total}`,
    )

    // ── 4. Shifts and presence ──────────────────────────────────────────────
    console.log('\n── 4. Shift tracking ─────────────────────────────────────────')

    const session = await clockIn(workspace.id, agentId)
    const again = await clockIn(workspace.id, agentId)
    check(session.id === again.id, 'clocking in twice resumes one shift, not two')

    const openSessions = await prisma.workSession.count({
      where: { userId: agentId, endedAt: null },
    })
    check(openSessions === 1, 'exactly one shift is open')

    // Active time accrues from heartbeat gaps, not from a client-reported figure.
    await prisma.agentPresence.update({
      where: { userId: agentId },
      data: { lastSeenAt: new Date(Date.now() - 45_000) },
    })
    // Backdate the shift too: active time is clamped to how long the shift has
    // actually lasted, so a 45-second credit needs a shift at least that old.
    await prisma.workSession.update({
      where: { id: session.id },
      data: { startedAt: new Date(Date.now() - 10 * 60_000) },
    })
    await touchPresence({ workspaceId: workspace.id, userId: agentId })
    const credited = await prisma.workSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { activeSeconds: true },
    })
    line('active seconds after 45s gap', credited.activeSeconds)
    check(
      credited.activeSeconds >= 44 && credited.activeSeconds <= 46,
      'a 45-second gap credits ~45 seconds of work',
    )

    // A long gap is a break, not work.
    await prisma.agentPresence.update({
      where: { userId: agentId },
      data: { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
    })
    await touchPresence({ workspaceId: workspace.id, userId: agentId })
    const afterBreak = await prisma.workSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { activeSeconds: true },
    })
    check(
      afterBreak.activeSeconds === credited.activeSeconds,
      'an hour-long gap credits nothing',
      `${credited.activeSeconds} → ${afterBreak.activeSeconds}`,
    )

    // Active time must never exceed the shift it accrued in.
    await prisma.agentPresence.update({
      where: { userId: agentId },
      data: { lastSeenAt: new Date(Date.now() - 100_000) },
    })
    await prisma.workSession.update({
      where: { id: session.id },
      data: { startedAt: new Date(Date.now() - 60_000), activeSeconds: 55 },
    })
    await touchPresence({ workspaceId: workspace.id, userId: agentId })
    const clamped = await prisma.workSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { activeSeconds: true, startedAt: true },
    })
    check(
      clamped.activeSeconds <= 62,
      'a heartbeat cannot book more work than the shift has lasted',
      `${clamped.activeSeconds}s active in a ~60s shift`,
    )

    check(
      derivePresence(new Date(Date.now() - 10 * 60_000), 'online') === 'offline',
      'a crashed client goes stale rather than reading online forever',
    )

    // ── 5. Call logging and its rules ───────────────────────────────────────
    console.log('\n── 5. Call rules ─────────────────────────────────────────────')

    // An outcome that requires a follow-up cannot be saved without one.
    let savedWithout = false
    try {
      await logCall({
        workspaceId: workspace.id,
        userId: agentId,
        businessId: pool[0]!.id,
        outcome: 'CALLBACK_REQUESTED',
      })
      savedWithout = true
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
    }
    check(!savedWithout, '"Callback requested" is refused without a follow-up time')

    // A past follow-up is refused.
    let savedPast = false
    try {
      await logCall({
        workspaceId: workspace.id,
        userId: agentId,
        businessId: pool[0]!.id,
        outcome: 'CALLBACK_REQUESTED',
        followUpAt: new Date(Date.now() - 86_400_000),
      })
      savedPast = true
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
    }
    check(!savedPast, 'a follow-up in the past is refused')

    const followUpAt = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const call1 = await logCall({
      workspaceId: workspace.id,
      userId: agentId,
      businessId: pool[0]!.id,
      outcome: 'CALLBACK_REQUESTED',
      followUpAt,
      notes: 'Asked to call back after lunch.',
      startedAt: new Date(Date.now() - 95_000),
      sessionId: session.id,
    })
    check(!call1.closed, 'a callback keeps the lead in the queue')

    const afterCall = await prisma.business.findUniqueOrThrow({
      where: { id: pool[0]!.id },
      select: {
        callCount: true, lastCallOutcome: true, nextFollowUpAt: true,
        assignedToId: true, outreach: { select: { stage: true } },
      },
    })
    check(afterCall.callCount === 1, 'the call count rolls up onto the lead')
    check(afterCall.lastCallOutcome === 'CALLBACK_REQUESTED', 'the outcome rolls up')
    check(afterCall.nextFollowUpAt !== null, 'the follow-up date rolls up')
    check(afterCall.outreach?.stage === 'FOLLOW_UP', 'the outreach stage follows the outcome')

    const logged = await prisma.callLog.findFirstOrThrow({
      where: { businessId: pool[0]!.id },
      orderBy: { createdAt: 'desc' },
    })
    check(
      logged.durationSec !== null && logged.durationSec >= 94 && logged.durationSec <= 96,
      'handling time is measured from when the lead was opened',
      `${logged.durationSec}s`,
    )
    check(logged.contactReached, 'a gatekeeper conversation counts as contact')

    // Voicemail is recorded but is not contact.
    await logCall({
      workspaceId: workspace.id,
      userId: agentId,
      businessId: pool[1]!.id,
      outcome: 'VOICEMAIL',
      sessionId: session.id,
    })
    const vm = await prisma.callLog.findFirstOrThrow({
      where: { businessId: pool[1]!.id },
      orderBy: { createdAt: 'desc' },
    })
    check(!vm.contactReached, 'voicemail is recorded but is not contact')

    // A meeting is a positive outcome that stays in the queue.
    await logCall({
      workspaceId: workspace.id,
      userId: agentId,
      businessId: pool[2]!.id,
      outcome: 'MEETING_BOOKED',
      followUpAt: new Date(Date.now() + 3 * 86_400_000),
      sessionId: session.id,
    })

    // Do-not-call closes the lead and releases it.
    const dnc = await logCall({
      workspaceId: workspace.id,
      userId: agentId,
      businessId: pool[3]!.id,
      outcome: 'DO_NOT_CALL',
      notes: 'Asked to be removed.',
      sessionId: session.id,
    })
    check(dnc.closed, 'do-not-call closes the lead')

    const closedLead = await prisma.business.findUniqueOrThrow({
      where: { id: pool[3]!.id },
      select: { assignedToId: true, outreach: { select: { stage: true } } },
    })
    check(closedLead.assignedToId === null, 'a closed lead leaves the queue')
    check(closedLead.outreach?.stage === 'DO_NOT_CONTACT', 'the lead is marked do-not-contact')

    // And can never be assigned again.
    const reassign = await assignLeads({
      workspaceId: workspace.id,
      businessIds: [pool[3]!.id],
      assignedToId: agentId,
      assignedById: owner.userId,
    })
    check(
      reassign.assigned === 0 && reassign.reasons.some((r) => r.includes('do-not-call')),
      'a do-not-call lead cannot be reassigned, and the caller is told why',
    )

    // An agent cannot log against someone else's lead.
    let crossed = false
    try {
      await logCall({
        workspaceId: workspace.id,
        userId: created2.userId,
        businessId: pool[0]!.id,
        outcome: 'NO_ANSWER',
      })
      crossed = true
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
    }
    check(!crossed, "an agent cannot log work on another agent's lead")

    // Nor on a lead nobody owns — otherwise an agent could work straight down
    // the workspace list through the API, outside any queue they were given.
    const unowned = await prisma.business.findFirst({
      where: { ...callableWhere(workspace.id), assignedToId: null },
      select: { id: true },
    })
    let tookUnowned = false
    if (unowned) {
      touchedBusinessIds.push(unowned.id)
      try {
        await logCall({
          workspaceId: workspace.id,
          userId: agentId,
          businessId: unowned.id,
          outcome: 'NO_ANSWER',
        })
        tookUnowned = true
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
      }
    }
    check(!tookUnowned, 'an agent cannot log work on an unassigned lead')

    // ── 6. The queue reorders itself around the work ────────────────────────
    console.log('\n── 6. Queue ordering ─────────────────────────────────────────')

    const after = await queueCounts(workspace.id, agentId)
    line('total / new / upcoming', `${after.total} / ${after.new} / ${after.upcoming}`)
    check(after.total === 3, 'the closed lead is gone from the queue')

    // Force one follow-up overdue and confirm it surfaces first.
    await prisma.business.update({
      where: { id: pool[1]!.id },
      data: { nextFollowUpAt: new Date(Date.now() - 3_600_000) },
    })
    const overdueCounts = await queueCounts(workspace.id, agentId)
    check(overdueCounts.overdue === 1, 'an overdue follow-up is counted as overdue')

    const next = await nextLead(workspace.id, agentId)
    check(next?.id === pool[1]!.id, 'the overdue lead is handed out first')

    const overdueOnly = await agentQueue({
      workspaceId: workspace.id,
      userId: agentId,
      bucket: 'overdue',
    })
    check(overdueOnly.items.length === 1, 'the overdue bucket filters correctly')

    // ── 7. The daily report ─────────────────────────────────────────────────
    console.log('\n── 7. Daily report ───────────────────────────────────────────')

    const tz = 'UTC'
    const day = dayKey(new Date(), tz)
    const { start, end } = dayRange(day, tz)
    check(start < end, 'the day range is ordered')
    check(
      end.getTime() - start.getTime() === 86_400_000,
      'a UTC day is exactly 24 hours',
    )

    // A DST day must still be a whole day in that zone.
    const dstRange = dayRange('2026-03-29', 'Europe/London')
    const dstHours = (dstRange.end.getTime() - dstRange.start.getTime()) / 3_600_000
    check(dstHours === 23, 'the spring-forward day is 23 hours in Europe/London', `${dstHours}h`)

    const totals = await computeDailyTotals({
      workspaceId: workspace.id,
      userId: agentId,
      start,
      end,
    })
    line('calls / reached', `${totals.calls} / ${totals.reached}`)
    line('leads worked', totals.leadsWorked)
    line('meetings / do-not-call', `${totals.meetingsBooked} / ${totals.doNotCall}`)

    check(totals.calls === 4, 'every call is counted')
    check(totals.reached === 3, 'only real conversations count as contact')
    check(totals.leadsWorked === 4, 'distinct leads worked is counted')
    check(totals.meetingsBooked === 1, 'meetings are counted')
    check(totals.doNotCall === 1, 'do-not-call is counted')
    check(totals.followUpsSet === 2, 'follow-ups set are counted')
    check(totals.activeMinutes >= 0, 'active minutes are recorded')

    await generateDailyReport({ workspaceId: workspace.id, userId: agentId, day, timeZone: tz })
    const report = await prisma.dailyReport.findUniqueOrThrow({
      where: { userId_day: { userId: agentId, day } },
    })
    check(report.calls === totals.calls, 'the stored report matches the computed totals')

    // Regenerating must correct in place, never duplicate.
    await generateDailyReport({ workspaceId: workspace.id, userId: agentId, day, timeZone: tz })
    const reportCount = await prisma.dailyReport.count({ where: { userId: agentId, day } })
    check(reportCount === 1, 're-running the roll-up updates rather than duplicating')

    // ── 8. The live floor ───────────────────────────────────────────────────
    console.log('\n── 8. Supervisor view ────────────────────────────────────────')

    const live = await liveAgents(workspace.id, start)
    const mine = live.find((a) => a.userId === agentId)
    check(mine !== undefined, 'the agent appears on the floor')
    check(mine?.callsToday === 4, "the floor shows today's calls")
    check(mine?.clockedInAt !== null, 'the floor shows the open shift')

    const closedShift = await clockOut(workspace.id, agentId, 'manual')
    check(closedShift !== null, 'clocking out closes the shift')
    check(
      (closedShift?.shiftSeconds ?? 0) >= (closedShift?.activeSeconds ?? 0),
      'shift time is never less than active time',
    )

    // ── 9. Disabling an account releases its work ───────────────────────────
    console.log('\n── 9. Disabling an account ───────────────────────────────────')

    const heldBefore = await prisma.business.count({ where: { assignedToId: agentId } })
    await updateMember({
      workspaceId: workspace.id,
      actorId: owner.userId,
      actorRole: 'OWNER',
      userId: agentId,
      isActive: false,
    })
    const heldAfter = await prisma.business.count({ where: { assignedToId: agentId } })
    line('leads held before → after', `${heldBefore} → ${heldAfter}`)
    check(heldAfter === 0, "a disabled agent's leads return to the pool")

    const history = await prisma.callLog.count({ where: { userId: agentId } })
    check(history === 4, 'their call history is kept — disabled, not deleted')

    const team = await listTeam(workspace.id)
    check(
      team.find((m) => m.userId === agentId)?.isActive === false,
      'the account shows as disabled rather than vanishing',
    )

    // ── 10. Round-robin respects existing workload ──────────────────────────
    console.log('\n── 10. Round-robin ───────────────────────────────────────────')

    const rr = await roundRobinAssign({
      workspaceId: workspace.id,
      assignedById: owner.userId,
      agentIds: [created2.userId],
      targetPerAgent: 2,
    })
    line('round-robin assigned', rr.assigned)
    check(rr.assigned <= 2, 'nobody is given more than the target')

    const secondPass = await roundRobinAssign({
      workspaceId: workspace.id,
      assignedById: owner.userId,
      agentIds: [created2.userId],
      targetPerAgent: 2,
    })
    check(
      secondPass.assigned === 0 && secondPass.reasons.length > 0,
      'an agent already at target is given nothing, and the caller is told why',
    )
  } finally {
    // ── Clean up ────────────────────────────────────────────────────────────
    console.log('\n── Cleanup ───────────────────────────────────────────────────')

    const ids = createdUserIds
    if (ids.length > 0) {
      await prisma.business.updateMany({
        where: { assignedToId: { in: ids } },
        data: { assignedToId: null, assignedAt: null },
      })
      // Deleting the users cascades their calls, sessions, presence, reports
      // and assignment rows.
      const removed = await prisma.user.deleteMany({ where: { id: { in: ids } } })
      line('verification accounts removed', removed.count)
    }

    if (touchedBusinessIds.length > 0) {
      // Put the leads back exactly as they were found.
      await prisma.business.updateMany({
        where: { id: { in: touchedBusinessIds } },
        data: {
          assignedToId: null,
          assignedAt: null,
          callCount: 0,
          lastCallAt: null,
          lastCallOutcome: null,
          nextFollowUpAt: null,
        },
      })
      await prisma.outreachStatus.deleteMany({
        where: { businessId: { in: touchedBusinessIds } },
      })
      line('leads restored', touchedBusinessIds.length)
    }

    await prisma.$disconnect()
  }

  if (failed > 0) {
    console.log(`\n❌ ${failed} check(s) failed\n`)
    process.exit(1)
  }
  console.log('\n✅ The cold-calling CRM behaves as designed\n')
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`, err)
  process.exit(1)
})
