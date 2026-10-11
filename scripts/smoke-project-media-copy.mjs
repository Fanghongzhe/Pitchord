import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-project-media-copy.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-media-copy-'))
const projectName = '媒体副本回归工程'
const project = path.join(root, projectName)
const source = path.join(root, 'external-source.wav')
const vocalSource = path.join(root, 'external-vocals.wav')
await fs.mkdir(project)
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({ version: 1, projectName, mediaName: '', duration: 0, segments: [], pitchPoints: [] }))
const samples = 44100
const wav = Buffer.alloc(44 + samples * 2)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(44100, 24)
wav.writeUInt32LE(88200, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(samples * 2, 40)
for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(3000 * Math.sin(index * 2 * Math.PI * 440 / 44100)), 44 + index * 2)
await fs.writeFile(source, wav)
await fs.writeFile(vocalSource, wav)
console.log(`Test root: ${root}`)

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Packaged Pitchord page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let id = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const current = ++id
  const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 10000)
  const listener = event => {
    const message = JSON.parse(event.data)
    if (message.id !== current) return
    clearTimeout(timeout)
    socket.removeEventListener('message', listener)
    if (message.error) reject(new Error(message.error.message))
    else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value ?? message.result)
  }
  socket.addEventListener('message', listener)
  socket.send(JSON.stringify({ id: current, method, params }))
})
const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async expression => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(expression)) return
    await pause(250)
  }
  throw new Error(`Timed out waiting for: ${expression}\n${await evaluate('document.body.innerText.slice(0, 1200)')}`)
}

try {
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:${JSON.stringify(projectName)},directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await pause(900)
  await waitFor(`!![...document.querySelectorAll('button')].find(button => button.textContent.includes(${JSON.stringify(projectName)}))`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes(${JSON.stringify(projectName)})).click()`)
  await waitFor(`document.body.textContent.includes('音频 / 视频')`)
  await pause(500)
  if (await evaluate(`!![...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置')`)) await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置').click()`)
  const document = await send('DOM.getDocument')
  const input = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type="file"][accept="audio/*,video/*"]' })
  assert.ok(input.nodeId, 'Media input missing')
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [source] })
  await waitFor(`document.body.textContent.includes('原媒体已复制到工程') || document.body.textContent.includes('并生成波形')`)
  await pause(500)
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'project.pitchord.json'), 'utf8'))
  assert.ok(manifest.assets?.media?.startsWith('media'), 'Project manifest lacks copied media')
  const copy = path.resolve(project, manifest.assets.media)
  assert.ok(copy.startsWith(project + path.sep), 'Copied media escaped the project')
  const hash = buffer => createHash('sha256').update(buffer).digest('hex')
  assert.equal(hash(await fs.readFile(copy)), hash(wav), 'Copied media content differs from source')
  const vocalInput = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type="file"][accept="audio/*"]' })
  assert.ok(vocalInput.nodeId, 'Vocal input missing')
  await send('DOM.setFileInputFiles', { nodeId: vocalInput.nodeId, files: [vocalSource] })
  await waitFor(`document.body.textContent.includes('人声分析轨已载入')`)
  const vocalManifest = JSON.parse(await fs.readFile(path.join(project, 'project.pitchord.json'), 'utf8'))
  assert.ok(vocalManifest.assets?.vocals?.startsWith('analysis'), 'Project manifest lacks copied vocal track')
  const vocalCopy = path.resolve(project, vocalManifest.assets.vocals)
  assert.ok(vocalCopy.startsWith(project + path.sep), 'Copied vocal track escaped the project')
  assert.equal(hash(await fs.readFile(vocalCopy)), hash(wav), 'Copied vocal content differs from source')
  await fs.unlink(source)
  await fs.unlink(vocalSource)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '返回所有项目').click()`)
  await waitFor(`document.body.textContent.includes('所有项目')`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes(${JSON.stringify(projectName)})).click()`)
  await waitFor(`document.body.textContent.includes('00:01.000')`)
  const restored = await evaluate(`({ body: document.body.innerText.includes('external-source.wav'), waveform: !document.body.innerText.includes('重新导入原媒体后显示波形') })`)
  assert.deepEqual(restored, { body: true, waveform: true })
  assert.equal(hash(await fs.readFile(vocalCopy)), hash(wav), 'Vocal copy disappeared after reopening')
  console.log(JSON.stringify({ sourcesRemoved: true, copy, vocalCopy, restored }))
} finally {
  socket.close()
}
