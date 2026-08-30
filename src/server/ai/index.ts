import 'server-only'
import { httpJson } from '@/server/http/client'
import { getConnectionBundle, getConnectionSecret } from '@/server/settings/connections'
import type { IssueDraft } from '@/server/audit/types'

/**
 * Optional AI-assisted UX review (§13).
 *
 * Rules this module exists to enforce:
 *  - It runs *after* deterministic measurement and receives those measurements,
 *    so it comments on observed facts rather than inventing them.
 *  - Everything it produces is stored with `source: 'AI_ASSISTED'` and a
 *    confidence, and is rendered with an "AI-assisted" badge.
 *  - It can never raise an opportunity on its own: opportunity scoring only
 *    counts deterministic evidence. AI adds colour, not verdicts (§44).
 */

export interface AiFinding {
  title: string
  description: string
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  confidence: 'MEDIUM' | 'LOW'
}

export interface AiReview {
  summary: string
  confidence: 'MEDIUM' | 'LOW'
  findings: AiFinding[]
  provider: string
  isDemo: boolean
}

export interface AIProvider {
  readonly id: string
  readonly isDemo: boolean
  configured(workspaceId?: string): Promise<{ state: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'; detail: string }>
  reviewScreenshots(input: {
    workspaceId?: string
    businessName: string
    url: string
    screenshots: Array<{ viewport: string; buffer: Buffer }>
    measuredFacts: Record<string, unknown>
  }): Promise<AiReview>
}

const SYSTEM_PROMPT = `You are assisting a website audit. You will receive screenshots of a business website plus a JSON object of measurements that were already collected deterministically by a browser.

Rules:
- Comment only on what is visible in the screenshots or present in the measurements.
- Do not restate the measurements as your own findings.
- Do not speculate about revenue, traffic or conversion rates.
- If the screenshots look fine, say so. An empty findings list is a valid answer.
- Focus on visual hierarchy, readability, trust signals, clarity of the primary call to action, and whether the design looks current.

Respond with JSON only:
{"summary": string, "confidence": "MEDIUM"|"LOW", "findings": [{"title": string, "description": string, "severity": "HIGH"|"MEDIUM"|"LOW", "confidence": "MEDIUM"|"LOW"}]}`

class OpenAIVisionProvider implements AIProvider {
  readonly id = 'openai'
  readonly isDemo = false

  async configured(workspaceId?: string) {
    const bundle = await getConnectionBundle(workspaceId, 'openai')
    if (bundle.decryptionError) {
      return { state: 'ERROR' as const, detail: bundle.decryptionError }
    }

    const apiKey = await getConnectionSecret(workspaceId, 'openai', 'apiKey')
    if (!apiKey) {
      return {
        state: 'NOT_CONFIGURED' as const,
        detail: 'Add an OpenAI API key in Settings > Connections to enable AI-assisted UX commentary. Audits run fully without it.',
      }
    }
    const model = bundle.config.model || 'gpt-4o-mini'
    return {
      state: 'CONNECTED' as const,
      detail: `Configured with model ${model}. Findings are labelled AI-assisted and never drive opportunity scores.`,
    }
  }

  async reviewScreenshots(input: {
    workspaceId?: string
    businessName: string
    url: string
    screenshots: Array<{ viewport: string; buffer: Buffer }>
    measuredFacts: Record<string, unknown>
  }): Promise<AiReview> {
    const bundle = await getConnectionBundle(input.workspaceId, 'openai')
    const apiKey = await getConnectionSecret(input.workspaceId, 'openai', 'apiKey')
    if (!apiKey) throw new Error('OpenAI API key is not configured')
    const model = bundle.config.model || 'gpt-4o-mini'

    const content: unknown[] = [
      {
        type: 'text',
        text: `Business: ${input.businessName}\nURL: ${input.url}\n\nDeterministic measurements already collected:\n${JSON.stringify(input.measuredFacts, null, 2)}`,
      },
    ]

    for (const shot of input.screenshots.slice(0, 2)) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${shot.buffer.toString('base64')}`,
          detail: 'low',
        },
      })
    }

    const res = await httpJson<{
      choices?: Array<{ message?: { content?: string } }>
      error?: { message?: string }
    }>('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
      timeoutMs: 60_000,
      retries: 1,
    })

    if (res.error) throw new Error(`AI provider: ${res.error.message}`)

    const raw = res.choices?.[0]?.message?.content
    if (!raw) throw new Error('AI provider returned an empty response')

    const parsed = JSON.parse(raw) as Partial<AiReview>
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      confidence: parsed.confidence === 'MEDIUM' ? 'MEDIUM' : 'LOW',
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.slice(0, 8).filter(isFinding)
        : [],
      provider: this.id,
      isDemo: false,
    }
  }
}

/**
 * The mock AI provider deliberately returns *no findings*. Anything else would
 * be putting invented design criticism in front of a salesperson.
 */
class MockAIProvider implements AIProvider {
  readonly id = 'mock-ai'
  readonly isDemo = true

  async configured(_workspaceId?: string) {
    return {
      state: 'CONNECTED' as const,
      detail: 'No AI provider configured. UX audits run on deterministic checks only.',
    }
  }

  async reviewScreenshots(): Promise<AiReview> {
    return {
      summary:
        'AI-assisted review was not run — no AI provider is configured. All UX findings on this audit come from deterministic browser measurements.',
      confidence: 'LOW',
      findings: [],
      provider: this.id,
      isDemo: true,
    }
  }
}

function isFinding(f: unknown): f is AiFinding {
  if (!f || typeof f !== 'object') return false
  const o = f as Record<string, unknown>
  return typeof o.title === 'string' && typeof o.description === 'string'
}

export async function getAIProvider(workspaceId?: string): Promise<AIProvider> {
  const apiKey = await getConnectionSecret(workspaceId, 'openai', 'apiKey').catch(() => undefined)
  return apiKey ? new OpenAIVisionProvider() : new MockAIProvider()
}

export async function openAIConnectionStatus(workspaceId?: string) {
  return new OpenAIVisionProvider().configured(workspaceId)
}

export async function aiProviderStatus(workspaceId?: string) {
  const openai = await openAIConnectionStatus(workspaceId)
  if (openai.state !== 'NOT_CONFIGURED') {
    return { id: 'openai', isDemo: false, ...openai }
  }
  const p = new MockAIProvider()
  return { id: p.id, isDemo: p.isDemo, ...(await p.configured(workspaceId)) }
}

/** Converts an AI review into issue drafts that are unmistakably AI-sourced. */
export function aiFindingsToIssues(review: AiReview, url: string): IssueDraft[] {
  return review.findings.map((f) => ({
    type: 'ux.ai.observation',
    category: 'UX' as const,
    severity: f.severity === 'HIGH' ? ('MEDIUM' as const) : ('LOW' as const),
    // AI findings are capped below deterministic ones on purpose: a subjective
    // observation must never outrank a measured defect.
    confidence: f.confidence === 'MEDIUM' ? ('MEDIUM' as const) : ('LOW' as const),
    title: f.title,
    description: f.description,
    evidence: {
      aiAssisted: true,
      provider: review.provider,
      modelConfidence: f.confidence,
      note: 'Subjective assessment from screenshot review. Not a measurement.',
    },
    affectedUrl: url,
    source: 'AI_ASSISTED' as const,
    recommendedAction: 'Review alongside the deterministic findings before quoting work.',
  }))
}
