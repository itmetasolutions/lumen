import { notFound } from 'next/navigation'
import Link from 'next/link'
import {
  ExternalLink, MapPin, Phone, Mail, Globe, Shield, ShieldAlert,
  Link2, Image as ImageIcon, Terminal, Clock, TrendingUp, Gauge,
  PaintRoller, Sparkles,
} from 'lucide-react'
import { requireAuth } from '@/server/auth/guard'
import { auditHistory, getBusinessProfile } from '@/server/leads/query'
import {
  Badge, Card, CardHeader, EmptyState, ScorePill, SeverityBadge,
} from '@/components/ui/primitives'
import { ReauditPanel } from '@/components/business/reaudit-panel'
import { DeepEnrichPanel } from '@/components/business/deep-enrich-panel'
import { OutreachPanel } from '@/components/business/outreach-panel'
import { IssueList } from '@/components/business/issue-list'
import { ScoreHistory } from '@/components/business/score-history'
import { SalesSummary } from '@/components/business/sales-summary'
import { AssignmentPanel, CallHistoryCard } from '@/components/crm/assignment-panel'
import { CopyValue, PhoneValue } from '@/components/crm/copy-value'
import { assignableAgents } from '@/server/crm/assignment'
import { OUTCOMES } from '@/server/crm/outcomes'
import { SOURCE_LABELS } from '@/components/data-table/columns'
import {
  NOT_FOUND, display, formatBytes, formatDateTime, formatMs,
  formatNumber, freshness,
} from '@/lib/utils'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const auth = await requireAuth()
  const b = await getBusinessProfile(auth.workspaceId, id)
  return { title: b?.name ?? 'Business' }
}

/**
 * Business intelligence profile (§10, §11).
 *
 * The organising principle: every claim on this page is traceable to a stored
 * measurement. Opportunities show why they triggered; issues show the evidence
 * that produced them; scores show the audit they came from.
 */
export default async function BusinessPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const auth = await requireAuth()

  const canAssign = auth.role === 'OWNER' || auth.role === 'ADMIN'

  const [business, history, agents] = await Promise.all([
    getBusinessProfile(auth.workspaceId, id),
    auditHistory(auth.workspaceId, id),
    canAssign ? assignableAgents(auth.workspaceId) : Promise.resolve([]),
  ])
  if (!business) notFound()

  const latest = business.audits[0] ?? null
  const seo = latest?.seoResult ?? null
  const ux = latest?.uxResult ?? null
  const tech = latest?.technical ?? null
  const perfMobile = latest?.performance.find((p) => p.strategy === 'MOBILE') ?? null
  const perfDesktop = latest?.performance.find((p) => p.strategy === 'DESKTOP') ?? null

  const phones = business.contacts.filter((c) => c.kind === 'PHONE')
  const emails = business.contacts.filter((c) => c.kind === 'EMAIL')
  const socials = business.contacts.filter((c) => c.kind === 'SOCIAL')

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{business.name}</h1>
            {business.isDemo && <Badge tone="demo">DEMO DATA</Badge>}
            {business.leadTier && (
              <Badge tone={business.leadTier === 'HOT' ? 'danger' : business.leadTier === 'WARM' ? 'warn' : 'neutral'}>
                {business.leadTier} LEAD
              </Badge>
            )}
            {business.openingStatus === 'CLOSED_PERMANENTLY' && (
              <Badge tone="danger">Permanently closed</Badge>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span>{display(business.industry)}</span>
            {business.category && <span>· {business.category}</span>}
            {business.city && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {[business.city, business.region, business.country].filter(Boolean).join(', ')}
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href="/leads/all">
            <span className="text-[13px] text-muted hover:text-fg">← Back to leads</span>
          </Link>
          <DeepEnrichPanel
            businessId={business.id}
            missing={[
              !business.websiteUrl && 'website',
              !business.primaryPhone && 'phone',
              !business.primaryEmail && 'email',
              !business.hasSocial && 'social',
              !business.addressLine && 'address',
            ].filter((m): m is string => typeof m === 'string')}
          />
          <ReauditPanel businessId={business.id} hasWebsite={Boolean(business.websiteUrl)} />
        </div>
      </div>

      {/* ── Score strip ──────────────────────────────────────────────────── */}
      <div className="mb-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <ScoreCard label="Lead Priority" score={business.leadScore} big />
        <ScoreCard label="Data Confidence" score={business.dataConfidence} />
        <ScoreCard label="Website Health" score={business.websiteHealth} />
        <ScoreCard label="SEO Health" score={business.seoHealth} />
        <ScoreCard label="Performance (Mobile)" score={business.perfHealthMobile} />
        <ScoreCard label="UX/UI Health" score={business.uxHealth} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-5">
          {/* ── Opportunities (§10 "explain exactly why") ────────────────── */}
          <Card>
            <CardHeader
              title="Opportunities"
              description="A business can qualify for several at once. Each shows the evidence that triggered it."
            />
            <div className="divide-y divide-border">
              {business.opportunities.length === 0 && (
                <div className="px-5 py-6 text-[13px] text-muted">
                  Opportunities are computed after the first audit completes.
                </div>
              )}
              {business.opportunities
                .slice()
                .sort((a, b) => Number(b.triggered) - Number(a.triggered) || b.score - a.score)
                .map((o) => (
                  <OpportunityBlock key={o.id} opportunity={o} />
                ))}
            </div>
          </Card>

          <SalesSummary
            businessName={business.name}
            opportunities={business.opportunities.map((o) => ({
              kind: o.kind,
              triggered: o.triggered,
              score: o.score,
              reasons: o.reasons as never,
            }))}
            rating={business.rating}
            reviewCount={business.reviewCount}
            hasPhone={business.hasPhone}
            hasEmail={business.hasEmail}
            perfMobile={business.perfScoreMobile}
            isDemo={business.isDemo}
          />

          {/* ── Audit stages ─────────────────────────────────────────────── */}
          {latest ? (
            <>
              <Card>
                <CardHeader
                  title="SEO audit"
                  description={
                    latest.seoStatus === 'OK'
                      ? `${seo?.issueCount ?? 0} findings from the latest audit`
                      : `Stage ${latest.seoStatus.toLowerCase()}${latest.seoError ? ` — ${latest.seoError}` : ''}`
                  }
                  actions={<StageBadge status={latest.seoStatus} />}
                />
                {seo && (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-b border-border px-5 py-4 text-[13px] sm:grid-cols-3">
                    <Fact label="Title" value={seo.title} extra={seo.titleLength ? `${seo.titleLength} chars` : undefined} />
                    <Fact label="Meta description" value={seo.metaDescription} extra={seo.metaDescLength ? `${seo.metaDescLength} chars` : undefined} />
                    <Fact label="H1" value={seo.h1Text} extra={`${seo.h1Count} on page`} />
                    <Fact label="Canonical" value={seo.canonicalUrl} />
                    <Fact label="robots.txt" value={seo.robotsTxtFound ? 'Present' : null} />
                    <Fact label="XML sitemap" value={seo.sitemapFound ? seo.sitemapUrl ?? 'Present' : null} />
                    <Fact label="Indexable" value={seo.isIndexable ? 'Yes' : `No — ${seo.noindexReason}`} />
                    <Fact label="Structured data" value={seo.schemaTypes.length ? seo.schemaTypes.join(', ') : null} />
                    <Fact label="Open Graph" value={seo.hasOpenGraph ? 'Present' : null} />
                    <Fact label="Images missing alt" value={`${seo.imagesMissingAlt} of ${seo.imagesTotal}`} />
                    <Fact label="Word count" value={seo.wordCount !== null ? formatNumber(seo.wordCount) : null} />
                    <Fact label="Broken internal links" value={String(seo.brokenInternalLinks)} />
                  </dl>
                )}
                <IssueList
                  issues={latest.issues
                    .filter((i) => i.category === 'SEO' || i.category === 'CONTENT')
                    .map(serializeIssue)}
                  emptyMessage={
                    latest.seoStatus === 'OK'
                      ? 'No SEO problems were detected.'
                      : 'The SEO stage did not produce findings.'
                  }
                />
              </Card>

              <Card>
                <CardHeader
                  title="Performance"
                  description="Mobile and desktop measured separately. Lab data and real-user field data kept apart."
                  actions={<StageBadge status={latest.performanceStatus} />}
                />
                {perfMobile || perfDesktop ? (
                  <div className="grid gap-px bg-border sm:grid-cols-2">
                    <PerfColumn title="Mobile" result={perfMobile} />
                    <PerfColumn title="Desktop" result={perfDesktop} />
                  </div>
                ) : (
                  <div className="px-5 py-5 text-[13px] text-muted">
                    {latest.performanceError ?? 'No performance measurement is available.'}
                  </div>
                )}
                <IssueList
                  issues={latest.issues.filter((i) => i.category === 'PERFORMANCE').map(serializeIssue)}
                  emptyMessage="No performance problems were detected."
                />
              </Card>

              <Card>
                <CardHeader
                  title="UX / UI"
                  description="Deterministic browser measurements at two viewports, plus screenshots."
                  actions={<StageBadge status={latest.uxStatus} />}
                />
                {ux ? (
                  <>
                    {ux.screenshots.length > 0 && (
                      <div className="grid gap-4 border-b border-border p-5 sm:grid-cols-2">
                        {ux.screenshots
                          .slice()
                          .sort((a, b) => a.viewport.localeCompare(b.viewport))
                          .map((s) => (
                            <figure key={s.id}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={`/api/screenshots/${s.id}`}
                                alt={`${business.name} at ${s.viewport}`}
                                className="w-full rounded-lg border border-border bg-surface-2"
                                loading="lazy"
                              />
                              <figcaption className="mt-1.5 text-2xs text-subtle">
                                {s.viewport.replace('-', ' · ')}
                              </figcaption>
                            </figure>
                          ))}
                      </div>
                    )}
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-b border-border px-5 py-4 text-[13px] sm:grid-cols-4">
                      <Fact label="Viewport meta" value={ux.hasViewportMeta ? 'Present' : 'Missing'} />
                      <Fact
                        label="Mobile overflow"
                        value={ux.horizontalOverflowPx === null ? null : `${ux.horizontalOverflowPx} px`}
                      />
                      <Fact label="Overlapping elements" value={String(ux.overlappingElements)} />
                      <Fact label="Broken images" value={`${ux.brokenImages} of ${ux.totalImages}`} />
                      <Fact label="Tap targets < 24px" value={String(ux.tinyTapTargets)} />
                      <Fact label="Low-contrast text" value={String(ux.lowContrastNodes)} />
                      <Fact label="Console errors" value={String(ux.consoleErrors)} />
                      <Fact label="Navigation issues" value={String(ux.navIssues)} />
                    </dl>
                    {ux.aiAssisted && ux.aiSummary && (
                      <div className="border-b border-border bg-surface-2/60 px-5 py-3.5">
                        <div className="mb-1 flex items-center gap-2">
                          <Sparkles className="h-3.5 w-3.5 text-accent" />
                          <span className="text-[13px] font-medium">AI-assisted observation</span>
                          <Badge tone="accent">confidence: {ux.aiConfidence}</Badge>
                        </div>
                        <p className="text-[13px] leading-5 text-muted">{ux.aiSummary}</p>
                        <p className="mt-1.5 text-2xs text-subtle">
                          Subjective commentary on the screenshots above. It does not affect
                          any score — opportunities are driven only by measurements.
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="px-5 py-5 text-[13px] text-muted">
                    {latest.uxError ?? 'The UX stage did not run for this audit.'}
                  </div>
                )}
                <IssueList
                  issues={latest.issues
                    .filter((i) => i.category === 'UX' || i.category === 'ACCESSIBILITY')
                    .map(serializeIssue)}
                  emptyMessage="No UX or accessibility problems were detected."
                />
              </Card>

              <Card>
                <CardHeader
                  title="Technical"
                  description="Status codes, redirects, transport security and asset integrity."
                  actions={<StageBadge status={latest.technicalStatus} />}
                />
                {tech && (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-b border-border px-5 py-4 text-[13px] sm:grid-cols-4">
                    <Fact label="Final status" value={tech.finalStatusCode !== null ? String(tech.finalStatusCode) : null} />
                    <Fact label="Redirects" value={String(tech.redirectCount)} />
                    <Fact label="HTTPS" value={tech.isHttps ? 'Yes' : 'No'} />
                    <Fact label="Mixed content" value={String(tech.mixedContentCount)} />
                    <Fact label="Broken links" value={`${tech.brokenLinks} of ${tech.checkedLinks} checked`} />
                    <Fact label="Missing assets" value={String(tech.missingAssets)} />
                    <Fact label="Console errors" value={String(tech.consoleErrors)} />
                    <Fact label="Server" value={tech.serverHeader} />
                  </dl>
                )}
                <IssueList
                  issues={latest.issues
                    .filter((i) => i.category === 'TECHNICAL' || i.category === 'SECURITY')
                    .map(serializeIssue)}
                  emptyMessage="No technical problems were detected."
                />
              </Card>

              {latest.pages.length > 0 && (
                <Card>
                  <CardHeader
                    title="Crawled pages"
                    description={`${latest.pagesCrawled} page(s) fetched during the ${latest.depth.toLowerCase()} audit`}
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-border bg-surface-2 text-2xs uppercase tracking-wide text-muted">
                          <th className="px-5 py-2 text-left font-semibold">URL</th>
                          <th className="px-3 py-2 text-left font-semibold">Role</th>
                          <th className="px-3 py-2 text-right font-semibold">Status</th>
                          <th className="px-3 py-2 text-right font-semibold">Size</th>
                          <th className="px-5 py-2 text-right font-semibold">Load</th>
                        </tr>
                      </thead>
                      <tbody>
                        {latest.pages.map((p) => (
                          <tr key={p.id} className="border-b border-border last:border-0">
                            <td className="max-w-md truncate px-5 py-2">
                              <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-accent">
                                {p.url}
                              </a>
                              {p.error && <div className="text-2xs text-danger">{p.error}</div>}
                            </td>
                            <td className="px-3 py-2"><Badge tone="outline">{p.role}</Badge></td>
                            <td className="px-3 py-2 text-right">
                              <span className={p.statusCode && p.statusCode >= 400 ? 'text-danger' : ''}>
                                {p.statusCode ?? '—'}
                              </span>
                            </td>
                            <td className="tnum px-3 py-2 text-right text-muted">{formatBytes(p.bytes)}</td>
                            <td className="tnum px-5 py-2 text-right text-muted">{formatMs(p.loadMs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          ) : (
            <Card>
              <EmptyState
                icon={<Globe className="h-5 w-5" />}
                title={business.websiteUrl ? 'Not audited yet' : 'No website to audit'}
                description={
                  business.websiteUrl
                    ? 'This business has a website but no completed audit. Queue one with Re-audit above — make sure the worker process is running.'
                    : 'No provider returned a website for this business, so there is nothing to crawl. That absence is itself the Website Creation opportunity.'
                }
              />
            </Card>
          )}
        </div>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <Card>
            <CardHeader title="Contact" />
            <div className="space-y-3 px-5 py-4 text-[13px]">
              <ContactBlock icon={<Phone className="h-3.5 w-3.5" />} label="Phone">
                {phones.length === 0 ? (
                  <Missing />
                ) : (
                  phones.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2">
                      <PhoneValue phone={p.value} size="sm" />
                      <Badge tone="outline">{SOURCE_LABELS[p.provider] ?? p.provider}</Badge>
                    </div>
                  ))
                )}
              </ContactBlock>

              <ContactBlock icon={<Mail className="h-3.5 w-3.5" />} label="Email">
                {emails.length === 0 ? (
                  <Missing />
                ) : (
                  emails.map((e) => (
                    <div key={e.id} className="flex min-w-0 items-center justify-between gap-2">
                      <CopyValue value={e.value} className="min-w-0" />
                      <Badge tone="outline">{SOURCE_LABELS[e.provider] ?? e.provider}</Badge>
                    </div>
                  ))
                )}
              </ContactBlock>

              <ContactBlock icon={<Link2 className="h-3.5 w-3.5" />} label="Social">
                {socials.length === 0 ? (
                  <Missing />
                ) : (
                  socials.map((s) => (
                    <a
                      key={s.id}
                      href={s.value}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="block truncate hover:text-accent"
                    >
                      {s.label ?? s.value}
                    </a>
                  ))
                )}
              </ContactBlock>

              <ContactBlock icon={<MapPin className="h-3.5 w-3.5" />} label="Address">
                <div className="leading-5">
                  {business.addressLine ? (
                    <>
                      {business.addressLine}
                      <br />
                      {[business.city, business.region, business.postalCode].filter(Boolean).join(', ')}
                      <br />
                      {business.country}
                    </>
                  ) : (
                    <Missing />
                  )}
                </div>
              </ContactBlock>
            </div>
          </Card>

          <Card>
            <CardHeader title="Website" />
            <div className="space-y-2.5 px-5 py-4 text-[13px]">
              {business.websiteUrl ? (
                <>
                  <a
                    href={business.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline"
                  >
                    {business.websiteDomain}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={business.websiteStatus === 'REACHABLE' ? 'ok' : 'warn'}>
                      {business.websiteStatus}
                    </Badge>
                    {business.website?.isHttps ? (
                      <Badge tone="ok"><Shield className="h-3 w-3" />HTTPS</Badge>
                    ) : (
                      <Badge tone="danger"><ShieldAlert className="h-3 w-3" />No HTTPS</Badge>
                    )}
                    {business.website?.cms && <Badge tone="outline">{business.website.cms}</Badge>}
                  </div>
                  {business.website?.redirectChain && business.website.redirectChain.length > 0 && (
                    <p className="text-2xs leading-4 text-subtle">
                      Redirects through {business.website.redirectChain.length} hop(s)
                    </p>
                  )}
                </>
              ) : (
                <div>
                  <Badge tone="danger">No website found</Badge>
                  <p className="mt-2 text-2xs leading-4 text-muted">
                    Checked across {business.sources.length} source(s). If a site exists but
                    is not listed anywhere, it will not be found here.
                  </p>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Provenance" description="Where each fact came from (§19)" />
            <ul className="divide-y divide-border">
              {business.sources.map((s) => (
                <li key={s.id} className="px-5 py-2.5 text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{SOURCE_LABELS[s.provider] ?? s.provider}</span>
                    <div className="flex items-center gap-1.5">
                      {s.isDemo && <Badge tone="demo">DEMO</Badge>}
                      <Badge tone="outline">trust {s.confidence}</Badge>
                    </div>
                  </div>
                  <div className="mt-0.5 text-2xs text-subtle">
                    Retrieved {formatDateTime(s.retrievedAt)}
                  </div>
                  {s.sourceUrl && (
                    <a
                      href={s.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="mt-0.5 block truncate text-2xs text-accent hover:underline"
                    >
                      {s.sourceUrl}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Freshness" description="§32 — how current is each signal" />
            <dl className="space-y-2 px-5 py-4 text-[13px]">
              <FreshRow label="Business data" date={business.lastSeenAt} />
              <FreshRow label="Website crawl" date={business.lastCrawledAt} />
              <FreshRow label="SEO audit" date={business.lastSeoAuditAt} />
              <FreshRow label="Performance" date={business.lastPerfAuditAt} />
              <FreshRow label="UX audit" date={business.lastUxAuditAt} />
              <FreshRow label="First discovered" date={business.discoveredAt} />
            </dl>
          </Card>

          {business.rating !== null && (
            <Card>
              <CardHeader title="Reputation" />
              <div className="px-5 py-4">
                <div className="flex items-baseline gap-2">
                  <span className="tnum text-2xl font-semibold">{business.rating.toFixed(1)}</span>
                  <span className="text-[13px] text-muted">
                    from {formatNumber(business.reviewCount)} reviews
                  </span>
                </div>
              </div>
            </Card>
          )}

          {canAssign && (
            <AssignmentPanel
              businessId={business.id}
              agents={agents.map((a) => ({
                id: a.id,
                name: a.name,
                role: a.role,
                openLeads: a.openLeads,
              }))}
              assignedTo={business.assignedTo}
              assignedAt={business.assignedAt?.toISOString() ?? null}
              doNotCall={
                business.lastCallOutcome === 'DO_NOT_CALL' ||
                business.outreach?.stage === 'DO_NOT_CONTACT'
              }
              callCount={business.callCount}
              nextFollowUpAt={business.nextFollowUpAt?.toISOString() ?? null}
            />
          )}

          <CallHistoryCard
            calls={business.callLogs.map((c) => ({
              id: c.id,
              outcome: c.outcome,
              contactReached: c.contactReached,
              notes: c.notes,
              durationSec: c.durationSec,
              followUpAt: c.followUpAt?.toISOString() ?? null,
              createdAt: c.createdAt.toISOString(),
              by: c.user.name ?? c.user.email,
            }))}
            outcomes={OUTCOMES.map((o) => ({ value: o.value, label: o.label, tone: o.tone }))}
          />

          <ScoreHistory history={history.map(serializeHistory)} />

          <OutreachPanel
            businessId={business.id}
            stage={business.outreach?.stage ?? 'NOT_CONTACTED'}
            tags={business.tags}
            nextFollowUpAt={business.outreach?.nextFollowUpAt?.toISOString() ?? null}
            notes={(business.outreach?.notes ?? []).map((n) => ({
              id: n.id,
              body: n.body,
              createdAt: n.createdAt.toISOString(),
            }))}
          />
        </aside>
      </div>
    </div>
  )
}

// ── small components ─────────────────────────────────────────────────────────

function serializeIssue(i: {
  id: string
  type: string
  category: string
  severity: string
  confidence: string
  title: string
  description: string
  evidence: unknown
  affectedUrl: string | null
  source: string
  recommendedAction: string
  detectedAt: Date
}) {
  return {
    id: i.id,
    type: i.type,
    category: i.category,
    severity: i.severity,
    confidence: i.confidence,
    title: i.title,
    description: i.description,
    evidence: i.evidence,
    affectedUrl: i.affectedUrl,
    source: i.source,
    recommendedAction: i.recommendedAction,
    detectedAt: i.detectedAt.toISOString(),
  }
}

function serializeHistory(a: {
  id: string
  startedAt: Date
  status: string
  isDemo: boolean
  seoHealth: number | null
  uxHealth: number | null
  technicalHealth: number | null
  perfHealthMobile: number | null
  perfHealthDesktop: number | null
  leadScore: number | null
  _count: { issues: number }
}) {
  return {
    id: a.id,
    startedAt: a.startedAt.toISOString(),
    status: a.status,
    isDemo: a.isDemo,
    seoHealth: a.seoHealth,
    uxHealth: a.uxHealth,
    technicalHealth: a.technicalHealth,
    perfHealthMobile: a.perfHealthMobile,
    perfHealthDesktop: a.perfHealthDesktop,
    leadScore: a.leadScore,
    issueCount: a._count.issues,
  }
}

const OPP_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  WEBSITE_CREATION: { label: 'Website Creation', icon: Globe },
  REDESIGN: { label: 'Website Redesign', icon: PaintRoller },
  SEO: { label: 'SEO', icon: TrendingUp },
  SPEED: { label: 'Speed Optimization', icon: Gauge },
}

function OpportunityBlock({
  opportunity,
}: {
  opportunity: {
    id: string
    kind: string
    triggered: boolean
    score: number
    reasons: unknown
    confidence: string
  }
}) {
  const meta = OPP_META[opportunity.kind] ?? { label: opportunity.kind, icon: Globe }
  const Icon = meta.icon
  const reasons = Array.isArray(opportunity.reasons)
    ? (opportunity.reasons as Array<{ label: string; detail: string; weight: number }>)
    : []

  return (
    <div className={opportunity.triggered ? '' : 'opacity-55'}>
      <div className="flex items-start gap-3 px-5 py-3.5">
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
            opportunity.triggered ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-subtle'
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold">{meta.label}</span>
            {opportunity.triggered ? (
              <Badge tone="accent">Triggered</Badge>
            ) : (
              <Badge tone="neutral">Not triggered</Badge>
            )}
            <ScorePill score={opportunity.score} inverted label="opportunity" />
            <Badge tone="outline">confidence: {opportunity.confidence}</Badge>
          </div>

          {reasons.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {reasons.map((r, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-5">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-subtle" />
                  <span>
                    <span className="font-medium">{r.label}</span>
                    {r.detail && <span className="text-muted"> — {r.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[13px] text-muted">
              No reasons recorded — this opportunity has not been evaluated yet.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function PerfColumn({
  title,
  result,
}: {
  title: string
  result: {
    provider: string
    isDemo: boolean
    score: number | null
    lcpMs: number | null
    fcpMs: number | null
    cls: number | null
    tbtMs: number | null
    ttfbMs: number | null
    fieldLcpMs: number | null
    fieldInpMs: number | null
    fieldSource: string | null
    pageWeightBytes: number | null
    requestCount: number | null
    renderBlockingCount: number | null
  } | null
}) {
  if (!result) {
    return (
      <div className="bg-surface px-5 py-4">
        <div className="text-[13px] font-medium">{title}</div>
        <p className="mt-1 text-[13px] text-muted">{NOT_FOUND}</p>
      </div>
    )
  }

  return (
    <div className="bg-surface px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] font-medium">{title}</span>
        <div className="flex items-center gap-1.5">
          {result.isDemo && <Badge tone="demo">DEMO</Badge>}
          <Badge tone="outline">{result.provider}</Badge>
        </div>
      </div>

      <div className="mb-3">
        <ScorePill score={result.score} label="/ 100" />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
        <Metric label="LCP" value={formatMs(result.lcpMs)} bad={(result.lcpMs ?? 0) > 4000} />
        <Metric label="CLS" value={result.cls === null ? NOT_FOUND : result.cls.toFixed(3)} bad={(result.cls ?? 0) > 0.25} />
        <Metric label="FCP" value={formatMs(result.fcpMs)} />
        <Metric label="TBT" value={formatMs(result.tbtMs)} />
        <Metric label="TTFB" value={formatMs(result.ttfbMs)} bad={(result.ttfbMs ?? 0) > 1800} />
        <Metric label="Page weight" value={formatBytes(result.pageWeightBytes)} />
        <Metric label="Requests" value={result.requestCount === null ? NOT_FOUND : String(result.requestCount)} />
        <Metric label="Render-blocking" value={result.renderBlockingCount === null ? NOT_FOUND : String(result.renderBlockingCount)} />
      </dl>

      {result.fieldSource && (
        <div className="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
          <div className="text-2xs font-semibold text-muted">
            Real-user data · {result.fieldSource}
          </div>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 text-[13px]">
            <Metric label="LCP" value={formatMs(result.fieldLcpMs)} />
            <Metric label="INP" value={formatMs(result.fieldInpMs)} />
          </dl>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`tnum text-right font-medium ${bad ? 'text-danger' : ''}`}>{value}</dd>
    </>
  )
}

function ScoreCard({
  label,
  score,
  big,
}: {
  label: string
  score: number | null
  big?: boolean
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-2xs text-muted">{label}</div>
      <div className={`mt-1.5 ${big ? 'text-2xl' : 'text-xl'}`}>
        {score === null ? (
          <span className="text-[13px] text-subtle">{NOT_FOUND}</span>
        ) : (
          <ScorePill score={score} />
        )}
      </div>
    </Card>
  )
}

function Fact({
  label,
  value,
  extra,
}: {
  label: string
  value: string | null | undefined
  extra?: string
}) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="mt-0.5 truncate">
        {value ? (
          <>
            {value}
            {extra && <span className="ml-1.5 text-2xs text-subtle">{extra}</span>}
          </>
        ) : (
          <Missing />
        )}
      </dd>
    </div>
  )
}

function Missing() {
  return <span className="text-2xs text-subtle">{NOT_FOUND}</span>
}

function ContactBlock({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-2xs uppercase tracking-wide text-subtle">
        {icon}
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function FreshRow({ label, date }: { label: string; date: Date | null }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-1.5">
        <Clock className="h-3 w-3 text-subtle" />
        <span className={date ? '' : 'text-subtle'}>{freshness(date)}</span>
      </dd>
    </div>
  )
}

function StageBadge({ status }: { status: string }) {
  const tone =
    status === 'OK' ? 'ok'
    : status === 'FAILED' ? 'danger'
    : status === 'SKIPPED' ? 'neutral'
    : 'info'
  return <Badge tone={tone as never}>{status}</Badge>
}
