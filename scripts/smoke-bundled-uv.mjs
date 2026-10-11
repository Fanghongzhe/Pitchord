import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import manifest from './runtime-manifest.json' with { type: 'json' }

const python = process.argv[2]
if (!python) throw new Error('Usage: node scripts/smoke-bundled-uv.mjs <python.exe>')
const wheel = path.resolve(import.meta.dirname, '..', 'vendor', 'uv', manifest.bootstrapInstaller.wheel)
const info = await fs.stat(wheel)
assert.equal(info.size, manifest.bootstrapInstaller.size)
const hash = createHash('sha256')
for await (const chunk of createReadStream(wheel)) hash.update(chunk)
assert.equal(hash.digest('hex'), manifest.bootstrapInstaller.sha256)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-uv-smoke-'))
const venv = path.join(root, 'venv')
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output || `Process exited with ${code}`)))
})
try {
  await run(python, ['-m', 'venv', venv])
  const venvPython = path.join(venv, 'Scripts', 'python.exe')
  await run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--no-deps', wheel])
  const version = (await run(venvPython, ['-m', 'uv', '--version'])).trim()
  assert.ok(version.startsWith(`uv ${manifest.bootstrapInstaller.version} `), version)
  console.log(version)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
