/**
 * Server-address parsing for the agent app.
 *
 * Pure string handling, deliberately in its own module with no `electron`
 * import: this is the logic most likely to be wrong in a way that strands an
 * agent on the setup screen, so it needs to be testable without an Electron
 * runtime. `agent-config.ts` re-exports it.
 */

/**
 * Accepts what a person would actually type.
 *
 * "192.168.1.10:3210" is a perfectly reasonable thing for a supervisor to read
 * out over a desk, and rejecting it for missing a scheme would be pedantry. A
 * bare host gets http; anything with a path or query is trimmed to the origin,
 * since the app supplies its own routes.
 */
export function normaliseServerUrl(input: string | null): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  // Only prepend a scheme when there is none. Testing for "://" rather than a
  // bare colon matters: "192.168.1.10:3210" has a colon but no scheme.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`

  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Whether a URL belongs to the configured server.
 *
 * Used to decide what may load in the app window versus what should open in the
 * system browser. Anything off the configured origin is somebody else's site.
 */
export function isOwnServer(target: string, serverUrl: string | null): boolean {
  if (!serverUrl) return false
  try {
    return new URL(target).origin === new URL(serverUrl).origin
  } catch {
    return false
  }
}
