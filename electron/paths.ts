import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Path resolution for dev vs packaged runs.
 *
 * Application payload (.next/standalone, prisma schema, compiled worker) ships
 * in `extraResources` rather than inside the asar archive: the Next standalone
 * server and the Prisma engines are real files that must be spawnable and
 * dlopen-able, and neither works from inside an asar.
 */

export const isPackaged = () => app.isPackaged

/** Root containing the application payload. */
export function resourceRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..')
}

/** Where the Next standalone server lives. */
export function standaloneDir(): string {
  return path.join(resourceRoot(), '.next', 'standalone')
}

export function standaloneServerJs(): string {
  return path.join(standaloneDir(), 'server.js')
}

/** Compiled worker, placed inside standalone so its requires resolve there. */
export function workerJs(): string {
  return path.join(standaloneDir(), 'worker.js')
}

export function prismaSchema(): string {
  return path.join(resourceRoot(), 'prisma', 'schema.prisma')
}

/** Per-machine writable state: database cluster, config, screenshots, exports. */
export function userDataDir(): string {
  return app.getPath('userData')
}

export function databaseDir(): string {
  return path.join(userDataDir(), 'pgdata')
}

export function storageDir(): string {
  return path.join(userDataDir(), 'storage')
}

export function logFile(): string {
  return path.join(userDataDir(), 'lumen.log')
}

export function ensureDirs(): void {
  for (const dir of [userDataDir(), storageDir()]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * Electron ships no standalone `node` binary. Running its own executable with
 * ELECTRON_RUN_AS_NODE=1 is the supported way to spawn a plain Node child.
 */
export function nodeExecutable(): string {
  return process.execPath
}

export function nodeChildEnv(
  // Deliberately not NodeJS.ProcessEnv: frameworks augment that type with
  // required keys, which would force every caller to restate them.
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ...extra,
  }
}
