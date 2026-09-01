import { describe, it, expect } from 'vitest'
import { isSecureRequest } from '@/server/auth/session'

/**
 * Session cookie security.
 *
 * The `Secure` attribute has to follow the actual connection rather than
 * NODE_ENV. Keyed on NODE_ENV, the packaged desktop build always set it — and a
 * browser silently discards a `Secure` cookie on any origin that is not a
 * secure context. Agents reaching their Lumen over `http://192.168.x.x:3210`
 * could therefore never sign in: the POST succeeded, the cookie was dropped
 * without a word, and they were returned to an empty login form.
 *
 * It went unnoticed because the desktop app talks to `127.0.0.1`, which *is* a
 * secure context and accepts the cookie. Only the LAN case broke, which is the
 * one case the agent app is for.
 */

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers })
}

describe('cookie security follows the connection', () => {
  it('marks the cookie Secure over https', () => {
    expect(isSecureRequest(request('https://lumen.example.com/api/auth/login'))).toBe(true)
  })

  it('does NOT mark it Secure over plain http on the LAN', () => {
    // The case that stranded every agent at the login screen.
    expect(isSecureRequest(request('http://192.168.1.14:3210/api/auth/login'))).toBe(false)
  })

  it('does not mark it Secure over http on localhost either', () => {
    // Harmless there — localhost is a secure context and would accept it — but
    // the rule is about the connection, and this connection is not encrypted.
    expect(isSecureRequest(request('http://127.0.0.1:3000/api/auth/login'))).toBe(false)
  })
})

describe('behind a TLS-terminating proxy', () => {
  it('trusts x-forwarded-proto over the local scheme', () => {
    // The proxy speaks https to the browser and http to us; the cookie the
    // browser receives travels over TLS, so it should be Secure.
    const req = request('http://127.0.0.1:3000/api/auth/login', {
      'x-forwarded-proto': 'https',
    })
    expect(isSecureRequest(req)).toBe(true)
  })

  it('reads only the first hop when several are listed', () => {
    const req = request('http://127.0.0.1:3000/api/auth/login', {
      'x-forwarded-proto': 'https, http',
    })
    expect(isSecureRequest(req)).toBe(true)
  })

  it('does not mark it Secure when the proxy reports http', () => {
    const req = request('https://internal.example.com/api/auth/login', {
      'x-forwarded-proto': 'http',
    })
    expect(isSecureRequest(req)).toBe(false)
  })

  it('tolerates odd casing and spacing', () => {
    const req = request('http://127.0.0.1:3000/api/auth/login', {
      'x-forwarded-proto': '  HTTPS  ',
    })
    expect(isSecureRequest(req)).toBe(true)
  })
})
