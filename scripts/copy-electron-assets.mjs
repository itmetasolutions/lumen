/**
 * tsc compiles the Electron TypeScript but ignores everything else.
 * The splash and agent-setup windows load HTML from disk, so it has to land
 * next to the compiled main process.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist-electron')

fs.mkdirSync(out, { recursive: true })

for (const asset of ['splash.html', 'agent-setup.html']) {
  fs.copyFileSync(path.join(root, 'electron', asset), path.join(out, asset))
  console.log(`[electron] copied ${asset}`)
}
