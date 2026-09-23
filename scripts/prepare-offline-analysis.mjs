import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const projectRoot = path.resolve(import.meta.dirname, '..')
const output = path.join(projectRoot, 'offline-analysis')
if (!output.startsWith(projectRoot + path.sep)) throw new Error('Invalid offline output directory')

const runtimeManifest = JSON.parse(await readFile(path.join(projectRoot, 'scripts', 'runtime-manifest.json'), 'utf8'))
const lockFile = path.join(projectRoot, 'scripts', 'analysis-lock-win-x64.txt')
const localRoot = path.join(process.env.LOCALAPPDATA || '', 'Pitchord')
const managedPython = path.join(localRoot, 'analysis-runtime', `v${runtimeManifest.analysisRuntimeVersion}`, 'Scripts', 'python.exe')
const models = path.join(localRoot, 'models')
if (!existsSync(managedPython)) throw new Error('请先在 Pitchord 中安装并验证当前分析环境。')
if (!existsSync(path.join(models, 'demucs', 'htdemucs.json'))) throw new Error('请先在 Pitchord 中准备并验证 htdemucs 模型。')

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })
}

async function sha256(file) {
  const hash = createHash('sha256')
  const stream = (await import('node:fs')).createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

await rm(output, { recursive: true, force: true })
await mkdir(path.join(output, 'base-runtime'), { recursive: true })
await mkdir(path.join(output, 'wheelhouse'), { recursive: true })

const archive = path.join(output, 'base-runtime', runtimeManifest.baseRuntime.archive)
console.log('Preparing standalone Python archive...')
await download(runtimeManifest.baseRuntime.url, archive)
const archiveStat = await stat(archive)
const archiveHash = await sha256(archive)
if (archiveStat.size !== runtimeManifest.baseRuntime.size || archiveHash !== runtimeManifest.baseRuntime.sha256) {
  throw new Error('Standalone Python archive verification failed')
}

console.log('Building the offline Python wheelhouse...')
await run(managedPython, ['-m', 'pip', 'wheel', '--wheel-dir', path.join(output, 'wheelhouse'), '--requirement', lockFile])
await cp(lockFile, path.join(output, 'analysis-lock-win-x64.txt'))

console.log('Copying verified model cache...')
await cp(models, path.join(output, 'models'), { recursive: true, force: true })

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  platform: 'win32-x64',
  analysisRuntimeVersion: runtimeManifest.analysisRuntimeVersion,
  baseRuntime: runtimeManifest.baseRuntime,
  lockSha256: await sha256(lockFile),
  model: 'htdemucs',
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
console.log(`Offline analysis bundle ready: ${output}`)
