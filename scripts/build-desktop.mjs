/**
 * Post-`next build` steps for the desktop package.
 *
 * Next's standalone output is a self-contained server plus only the node_modules
 * it traced. Three things it does not do for us:
 *   1. copy the static assets and public/ into the standalone tree
 *   2. include the background worker, which is a separate entry point
 *   3. include packages that are only ever imported dynamically, which tracing
 *      cannot see
 *
 * Run: node scripts/build-desktop.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const standalone = path.join(root, '.next', 'standalone')

function step(message) {
  console.log(`[desktop] ${message}`)
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, dereference: true })
  return true
}

async function main() {
  if (!fs.existsSync(standalone)) {
    throw new Error(
      'No .next/standalone directory. Run "npm run build" first (next.config.mjs must set output: "standalone").',
    )
  }

  // ── 1. Static assets ───────────────────────────────────────────────────────
  step('copying static assets into the standalone tree')
  copyDir(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'))
  copyDir(path.join(root, 'public'), path.join(standalone, 'public'))

  // ── 2. Worker bundle ───────────────────────────────────────────────────────
  // Bundled rather than shipped as TypeScript so the packaged app needs no
  // TypeScript runtime. Placed inside standalone so its requires resolve
  // against the node_modules Next already vendored there.
  step('bundling the background worker')
  await build({
    entryPoints: [path.join(root, 'scripts', 'worker.ts')],
    outfile: path.join(standalone, 'worker.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    minify: false,
    // Anything with native binaries, a heavy runtime, or lazy loading stays
    // external and is resolved from the standalone node_modules at run time.
    external: [
      '@prisma/client',
      '.prisma/client',
      'prisma',
      'playwright-core',
      'exceljs',
      'bullmq',
      'ioredis',
      'server-only',
      'next',
      // Optional peers the Lighthouse provider imports dynamically. They are
      // intentionally not installed; the provider catches the failed import and
      // reports NOT_CONFIGURED. Marking them external preserves that behaviour
      // instead of failing the build.
      'lighthouse',
      'chrome-launcher',
    ],
    // The worker's imports use the same @/ alias as the app.
    alias: { '@': path.join(root, 'src') },
    logLevel: 'warning',
  })

  // `server-only` throws outside a React Server build. The worker is plain Node,
  // so it resolves to the package's own no-op — the same thing the
  // --conditions=react-server flag does in development.
  step('neutralising the server-only guard for the worker')
  const workerFile = path.join(standalone, 'worker.js')
  let workerSource = fs.readFileSync(workerFile, 'utf8')
  workerSource = workerSource.replace(
    /require\(["']server-only["']\)/g,
    '(void 0)',
  )
  fs.writeFileSync(workerFile, workerSource)

  // ── 3. Dynamically-imported packages ───────────────────────────────────────
  // Next traces static imports. These are loaded through `await import(...)` at
  // run time, so they must be copied in explicitly or the UX and export stages
  // fail in the packaged app while working perfectly in development.
  step('copying dynamically-imported packages')
  const dynamicPackages = ['playwright-core', 'exceljs', '@prisma/client', '.prisma']
  for (const pkg of dynamicPackages) {
    const target = path.join(standalone, 'node_modules', pkg)
    if (fs.existsSync(target)) {
      step(`  ${pkg} — already traced`)
      continue
    }
    const copied = copyDir(path.join(root, 'node_modules', pkg), target)
    step(`  ${pkg} — ${copied ? 'copied' : 'NOT FOUND (skipped)'}`)
  }

  // ── 4. Sanity check ────────────────────────────────────────────────────────
  step('verifying the standalone tree')
  const required = [
    ['server.js', path.join(standalone, 'server.js')],
    ['worker.js', workerFile],
    ['.next/static', path.join(standalone, '.next', 'static')],
    ['@prisma/client', path.join(standalone, 'node_modules', '@prisma', 'client')],
  ]

  const missing = required.filter(([, p]) => !fs.existsSync(p))
  for (const [name, p] of required) {
    console.log(`  ${fs.existsSync(p) ? 'ok  ' : 'MISS'} ${name}`)
  }
  if (missing.length > 0) {
    throw new Error(`Standalone tree incomplete: ${missing.map(([n]) => n).join(', ')}`)
  }

  step('done')
}

main().catch((err) => {
  console.error(`[desktop] failed: ${err.message}`)
  process.exit(1)
})
