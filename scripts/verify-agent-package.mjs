/**
 * Guards the agent installer's file list.
 *
 * `electron-builder.agent.json` names each compiled file the agent ships,
 * one by one, because the agent must NOT carry the main app's server, database
 * or Postgres dependencies — it is a client, and an allow-list is the only way
 * to keep it at 97 MB instead of 900.
 *
 * The cost of that allow-list is that adding a module to the agent's require
 * graph and forgetting to list it produces a build that packages, installs, and
 * signs perfectly — then dies on launch with "Cannot find module". Nothing in
 * the pipeline notices, because from electron-builder's point of view nothing is
 * wrong: it packed exactly what it was told to.
 *
 * That is precisely how v0.2.0 shipped an agent app that could not start:
 * `agent-config.js` requires `./server-url`, which was never on the list.
 *
 * So this walks the real require graph from the entry point and fails the build
 * if anything it reaches is missing from the list.
 *
 * Run: node scripts/verify-agent-package.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const CONFIG = 'electron-builder.agent.json'
const OUT_DIR = 'dist-electron'

/** Assets Electron loads by path rather than through require(). */
const RUNTIME_ASSETS = ['agent-setup.html', 'agent-setup-preload.js']

function requireClosure(entry) {
  const seen = new Set()
  const missingOnDisk = []
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)

    const full = path.join(OUT_DIR, file)
    if (!fs.existsSync(full)) {
      missingOnDisk.push(file)
      continue
    }

    const source = fs.readFileSync(full, 'utf8')
    // Relative requires only — bare specifiers are node_modules, which the
    // config handles separately.
    const pattern = /require\(["'](\.[^"']+)["']\)/g
    let match
    while ((match = pattern.exec(source)) !== null) {
      let target = match[1].replace(/^\.\//, '')
      if (!target.endsWith('.js')) target += '.js'
      queue.push(target)
    }
  }

  return { reached: [...seen].sort(), missingOnDisk }
}

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  const entry = config.extraMetadata?.main
  if (!entry) throw new Error(`${CONFIG} has no extraMetadata.main`)

  const entryFile = path.basename(entry)
  const { reached, missingOnDisk } = requireClosure(entryFile)

  if (missingOnDisk.length > 0) {
    console.error('\n✗ These are required but were never compiled:')
    for (const f of missingOnDisk) console.error(`    ${OUT_DIR}/${f}`)
    console.error('\n  Run "npm run agent:build" first.\n')
    process.exit(1)
  }

  const listed = new Set(
    config.files.filter((f) => typeof f === 'string' && f.startsWith(`${OUT_DIR}/`)),
  )

  const needed = [...reached, ...RUNTIME_ASSETS]
  const missing = needed.filter((f) => !listed.has(`${OUT_DIR}/${f}`))

  console.log(`\nAgent package — ${needed.length} file(s) required from ${OUT_DIR}/`)
  for (const f of needed.sort()) {
    const ok = listed.has(`${OUT_DIR}/${f}`)
    console.log(`  ${ok ? '✓' : '✗'} ${f}`)
  }

  // Listing something the agent never loads is waste, not breakage — worth
  // saying, but not worth failing over.
  const unused = [...listed].filter(
    (f) => !needed.includes(f.slice(OUT_DIR.length + 1)),
  )
  if (unused.length > 0) {
    console.log('\n  Listed but never loaded (harmless, just weight):')
    for (const f of unused) console.log(`    ${f}`)
  }

  if (missing.length > 0) {
    console.error(`\n✗ ${missing.length} file(s) missing from "files" in ${CONFIG}:`)
    for (const f of missing) console.error(`    "${OUT_DIR}/${f}",`)
    console.error(
      '\n  The installer would build and install cleanly, then fail on launch\n' +
        '  with "Cannot find module". Add the lines above and rebuild.\n',
    )
    process.exit(1)
  }

  console.log('\n✅ Every file the agent loads is in the package\n')
}

main()
