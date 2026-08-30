/**
 * electron-builder afterPack hook.
 *
 * The Next standalone tree carries its own vendored `node_modules`, and
 * electron-builder deliberately skips any `node_modules` directory it finds
 * inside an `extraResources` source — it manages dependencies itself. That left
 * the packaged server with no modules to require and it died on startup with
 * "Cannot find module 'next'".
 *
 * Copying the tree here, after packing, bypasses that filter entirely.
 */
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const projectRoot = path.resolve(__dirname, '..')
  const source = path.join(projectRoot, '.next', 'standalone')
  const destination = path.join(context.appOutDir, 'resources', 'app', '.next', 'standalone')

  if (!fs.existsSync(source)) {
    throw new Error(
      `afterPack: ${source} is missing. Run "npm run desktop:build" before packaging.`,
    )
  }

  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true, dereference: true })

  // Fail the build rather than shipping an installer that cannot start.
  const required = [
    'server.js',
    'worker.js',
    path.join('node_modules', 'next'),
    path.join('node_modules', '@prisma', 'client'),
    path.join('.next', 'static'),
  ]

  const missing = required.filter((rel) => !fs.existsSync(path.join(destination, rel)))
  if (missing.length > 0) {
    throw new Error(`afterPack: standalone tree incomplete — missing ${missing.join(', ')}`)
  }

  const count = fs.readdirSync(path.join(destination, 'node_modules')).length
  console.log(`  • afterPack: standalone copied (${count} vendored packages)`)
}
