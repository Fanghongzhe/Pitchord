import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const projectRoot = path.resolve(import.meta.dirname, '..')
const output = path.join(projectRoot, `release-desktop-v${packageJson.version}`)
const unpacked = path.join(output, 'win-unpacked')
const bundleRoot = path.join(output, 'Pitchord')
const archive = path.join(output, `Pitchord-${packageJson.version}-windows-x64.zip`)

for (const target of [bundleRoot, archive]) {
  if (!target.startsWith(output + path.sep)) throw new Error('Invalid portable bundle output path')
  await rm(target, { recursive: true, force: true })
}
if (!existsSync(path.join(unpacked, 'Pitchord.exe'))) throw new Error('Packaged Pitchord directory was not found')

await rename(unpacked, bundleRoot)
await new Promise((resolve, reject) => {
  const child = spawn('tar.exe', ['-a', '-cf', archive, 'Pitchord'], { cwd: output, windowsHide: true, stdio: 'inherit' })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`tar.exe exited with ${code}`)))
})
console.log(`Portable bundle ready: ${archive}`)
