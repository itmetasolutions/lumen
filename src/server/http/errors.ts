/**
 * The error type every server service throws to signal an HTTP outcome.
 *
 * It lives here rather than in the auth guard because the guard imports
 * `next/navigation` for its `redirect()`, and that pulls the React client
 * runtime in with it. Services like call logging and lead assignment need to
 * throw a 403 without dragging a router into the background worker — so the
 * error is a plain class with no framework dependency at all, and the guard
 * re-exports it for the route handlers that already import it from there.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
