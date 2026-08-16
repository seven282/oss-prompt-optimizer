// Copy the hand-written ModuleLoader client bundle into lib/ so the package's
// exports map ("./client": "./lib/client.js") resolves after `tsc` builds.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'client', 'client.js')
const target = join(root, 'lib', 'client.js')
mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`copied ${source} -> ${target}`)
