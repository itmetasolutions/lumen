import fs from 'node:fs'
import { logFile, userDataDir } from './paths'

/**
 * Boot log.
 *
 * A packaged app has no console the user can see, and the boot sequence spans
 * three child processes. When startup fails, this file is the only way anyone —
 * including the user reporting the bug — can tell which stage broke.
 */

const buffer: string[] = []
const MAX_BUFFER = 500

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`

  buffer.push(line)
  if (buffer.length > MAX_BUFFER) buffer.shift()

  // eslint-disable-next-line no-console
  console.log(line)

  try {
    fs.mkdirSync(userDataDir(), { recursive: true })
    fs.appendFileSync(logFile(), `${line}\n`, 'utf8')
  } catch {
    // Never let logging be the reason startup fails.
  }
}

export function recentLog(): string {
  return buffer.join('\n')
}
