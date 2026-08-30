import 'server-only'
import { env } from '@/server/env'

/**
 * Browser acquisition for the UX stage.
 *
 * `playwright-core` is used rather than `playwright` so that installing this
 * project does not download three browser engines. Instead we drive a browser
 * the machine already has — Edge on Windows, Chrome elsewhere. If none is
 * available the UX stage reports SKIPPED with a reason, which is honest; it does
 * not fabricate layout findings (§21, §31).
 */

export interface BrowserHandle {
  browser: import('playwright-core').Browser
  close(): Promise<void>
}

export class BrowserUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'BrowserUnavailableError'
  }
}

const CHANNEL_FALLBACKS = ['msedge', 'chrome', 'chrome-beta', 'msedge-beta']

export async function launchBrowser(): Promise<BrowserHandle> {
  let chromium: typeof import('playwright-core').chromium
  try {
    ;({ chromium } = await import('playwright-core'))
  } catch {
    throw new BrowserUnavailableError(
      'playwright-core is not installed. Run: npm install playwright-core',
    )
  }

  const channels = [env.playwrightChannel, ...CHANNEL_FALLBACKS].filter(
    (c, i, arr) => c && arr.indexOf(c) === i,
  )

  const failures: string[] = []

  for (const channel of channels) {
    try {
      const browser = await chromium.launch({
        channel,
        headless: true,
        args: ['--disable-dev-shm-usage', '--no-sandbox'],
      })
      return { browser, close: () => browser.close() }
    } catch (err) {
      failures.push(`${channel}: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  // Last resort: a bundled Chromium, if the full playwright package happens to
  // be installed alongside.
  try {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    return { browser, close: () => browser.close() }
  } catch (err) {
    failures.push(`bundled: ${(err as Error).message.split('\n')[0]}`)
  }

  throw new BrowserUnavailableError(
    `No usable browser found. Install Microsoft Edge or Google Chrome, or run "npx playwright install chromium". Tried — ${failures.join(' | ')}`,
  )
}

export const VIEWPORTS = {
  desktop: { name: 'desktop-1440x900', width: 1440, height: 900, isMobile: false },
  mobile: { name: 'mobile-390x844', width: 390, height: 844, isMobile: true },
} as const

export type ViewportKey = keyof typeof VIEWPORTS
