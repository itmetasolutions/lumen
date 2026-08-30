import net from 'node:net'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import {
  standaloneDir,
  standaloneServerJs,
  workerJs,
  storageDir,
  nodeExecutable,
  nodeChildEnv,
} from './paths'
import type { AppConfig } from './config'
import { databaseUrl } from './config'
import { log } from './log'

/**
 * The Next server and the background worker run as separate Node child
 * processes, exactly as they do in development. Keeping the split means the
 * desktop build exercises the same code paths as the server build — audits and
 * discovery still cannot block the UI.
 */

let serverProcess: ChildProcess | null = null
let workerProcess: ChildProcess | null = null
let shuttingDown = false

export interface RuntimeHandle {
  port: number
  url: string
  /** Addresses agents can be given, when sharing is on. */
  lanUrls: string[]
}

/** Ask the OS for a free port rather than guessing one that may be taken. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (typeof address === 'object' && address) {
        const { port } = address
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Could not determine a free port')))
      }
    })
  })
}

function childEnv(config: AppConfig, port: number): NodeJS.ProcessEnv {
  return nodeChildEnv({
    NODE_ENV: 'production',
    PORT: String(port),
    // 0.0.0.0 only when the user has asked for it. The default stays on the
    // loopback interface, where nothing outside this machine can reach it.
    HOSTNAME: config.shareOnNetwork ? '0.0.0.0' : '127.0.0.1',
    DATABASE_URL: databaseUrl(config),
    DATABASE_URL_UNPOOLED: databaseUrl(config),
    AUTH_SECRET: config.authSecret,
    QUEUE_DRIVER: 'pg',
    // Screenshots and generated exports belong in the user's data directory,
    // not next to the read-only program files.
    STORAGE_DIR: storageDir(),
  })
}

export async function startServer(config: AppConfig): Promise<RuntimeHandle> {
  const serverJs = standaloneServerJs()
  if (!fs.existsSync(serverJs)) {
    throw new Error(
      `Next server not found at ${serverJs}. The build step "npm run build" must run before packaging.`,
    )
  }

  // A shared server needs a stable address someone can write down; a private
  // one can take whatever port the OS has spare.
  const port = config.shareOnNetwork ? config.sharePort : await findFreePort()
  const url = `http://127.0.0.1:${port}`
  const lanUrls = config.shareOnNetwork ? localAddresses(port) : []

  log(
    `server: starting on ${url}` +
      (lanUrls.length > 0 ? ` (also reachable at ${lanUrls.join(', ')})` : ''),
  )
  serverProcess = spawn(nodeExecutable(), [serverJs], {
    cwd: standaloneDir(),
    env: childEnv(config, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProcess.stdout?.on('data', (d) => log(`server: ${d.toString().trim()}`))
  serverProcess.stderr?.on('data', (d) => log(`server: ${d.toString().trim()}`))
  serverProcess.on('exit', (code) => {
    log(`server: exited with code ${code}`)
    serverProcess = null
    if (!shuttingDown) onUnexpectedExit?.('The application server stopped unexpectedly.')
  })

  await waitForHttp(`${url}/login`, 60_000)
  log('server: ready')

  return { port, url, lanUrls }
}

/**
 * The addresses an agent could actually type.
 *
 * Only IPv4, and only non-internal interfaces: a supervisor reading an address
 * out to their team needs the one on the office network, not a loopback or a
 * link-local address that will not route.
 */
export function localAddresses(port: number): string[] {
  const urls: string[] = []
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      urls.push(`http://${address.address}:${port}`)
    }
  }
  return urls
}

export function startWorker(config: AppConfig, port: number): void {
  const worker = workerJs()
  if (!fs.existsSync(worker)) {
    // The app is still usable for browsing existing data without a worker, so
    // this is a warning rather than a fatal error.
    log(`worker: not found at ${worker} — discovery, audits and exports will not run`)
    return
  }

  log('worker: starting')
  workerProcess = spawn(nodeExecutable(), [worker], {
    cwd: standaloneDir(),
    env: childEnv(config, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  workerProcess.stdout?.on('data', (d) => log(`worker: ${d.toString().trim()}`))
  workerProcess.stderr?.on('data', (d) => log(`worker: ${d.toString().trim()}`))
  workerProcess.on('exit', (code) => {
    log(`worker: exited with code ${code}`)
    workerProcess = null
    // A dead worker stalls jobs but must not take the window down; restart it
    // unless the app is closing.
    if (!shuttingDown) {
      log('worker: restarting in 5s')
      setTimeout(() => {
        if (!shuttingDown) startWorker(config, port)
      }, 5_000)
    }
  })
}

let onUnexpectedExit: ((message: string) => void) | null = null

export function setUnexpectedExitHandler(fn: (message: string) => void): void {
  onUnexpectedExit = fn
}

/** Polls until the server answers, so the window never opens on a dead port. */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      // Any HTTP answer means the server is up; /login redirects when signed in.
      if (res.status > 0) return
    } catch (err) {
      lastError = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 400))
  }

  throw new Error(`Server did not become ready within ${timeoutMs / 1000}s (${lastError})`)
}

export async function stopAll(): Promise<void> {
  shuttingDown = true

  for (const [name, child] of [
    ['worker', workerProcess],
    ['server', serverProcess],
  ] as const) {
    if (!child) continue
    log(`${name}: stopping`)
    child.kill()
  }

  // Give them a moment to exit cleanly before the process tree is torn down.
  await new Promise((r) => setTimeout(r, 1_500))

  for (const child of [workerProcess, serverProcess]) {
    if (child && !child.killed) child.kill('SIGKILL')
  }

  workerProcess = null
  serverProcess = null
}
