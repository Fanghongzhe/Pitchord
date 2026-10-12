import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2]
const sourceRuntime = process.argv[3]
if (!port || !sourceRuntime) throw new Error('Usage: node scripts/smoke-existing-environment.mjs <debug-port> <base-runtime-folder>')
const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-reuse-environment-'))
const oldRoot = path.join(parent, 'Pitchord-old', 'environment')
await fs.mkdir(oldRoot, { recursive: true })
await fs.symlink(sourceRuntime, path.join(oldRoot, 'base-runtime'), 'junction')
const whisper = path.join(oldRoot, 'models', 'whisper', 'small')
await fs.mkdir(whisper, { recursive: true })
await fs.writeFile(path.join(whisper, 'pitchord-model.json'), '{}')
await fs.writeFile(path.join(whisper, 'model.bin'), 'test-only-placeholder')

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord page missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let id = 0
const evaluate = expression => new Promise((resolve, reject) => {
  const current = ++id
  const timer = setTimeout(() => reject(new Error(`CDP timed out: ${expression.slice(0, 100)}`)), 90000)
  const listener = event => {
    const message = JSON.parse(event.data)
    if (message.id !== current) return
    clearTimeout(timer)
    socket.removeEventListener('message', listener)
    if (message.error) reject(new Error(message.error.message))
    else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  }
  socket.addEventListener('message', listener)
  socket.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
})

let before
try {
  before = JSON.parse(await evaluate('window.pitchordDesktop.analysisStatus().then(JSON.stringify)'))
  if (!await evaluate(`[...document.querySelectorAll('button')].some(item => /^(分析环境|准备分析环境|检查或更换环境|复用整套环境)$/.test(item.textContent.trim()))`)) {
    await evaluate(`[...document.querySelectorAll('button')].find(item => item.textContent.trim() === '新建项目')?.click()`)
    await new Promise(resolve => setTimeout(resolve, 250))
    await evaluate(`(() => { const dialog = document.querySelector('[role="dialog"]'); const inputs = [...dialog.querySelectorAll('input')]; const set = (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }; set(inputs[0], '旧环境复用测试'); set(inputs[1], ${JSON.stringify(parent)}); [...dialog.querySelectorAll('button')].find(button => button.textContent.includes('创建工程')).click() })()`)
    await new Promise(resolve => setTimeout(resolve, 600))
  }
  let visible = false
  for (let attempt = 0; attempt < 40 && !visible; attempt++) {
    visible = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '复用整套环境'); if (!button) { [...document.querySelectorAll('button')].find(item => /^(分析环境|准备分析环境|检查或更换环境)$/.test(item.textContent.trim()))?.click(); return false } button.click(); return document.body.textContent.includes('旧版 environment 文件夹') })()`)
    if (!visible) await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!visible) console.log((await evaluate('document.body.innerText')).slice(0, 1800))
  assert.equal(visible, true, 'Whole-environment picker is not visible')
  const status = JSON.parse(await evaluate(`window.pitchordDesktop.configureAnalysisEnvironment(${JSON.stringify({ mode: 'existing', root: oldRoot })}).then(JSON.stringify)`))
  assert.equal(status.root, oldRoot)
  assert.equal(status.runtimePreference, 'existing')
  assert.equal(status.source, 'existing')
  assert.equal(status.alignment.models.find(model => model.id === 'small')?.ready, true)
  assert.equal(status.modelDirectory, path.join(oldRoot, 'models'))
  assert.ok(status.path.startsWith(path.join(oldRoot, 'base-runtime')))
  const alignmentGuard = await evaluate(`window.pitchordDesktop.alignLyrics({ segments: [], duration: 1, model: 'small' }).then(() => 'unexpected success', error => error.message)`)
  assert.match(alignmentGuard, /纯人声分离结果/)
  const inferred = JSON.parse(await evaluate(`window.pitchordDesktop.configureAnalysisEnvironment(${JSON.stringify({ mode: 'custom', pythonPath: status.path })}).then(JSON.stringify)`))
  assert.equal(inferred.root, oldRoot)
  assert.equal(inferred.runtimePreference, 'existing')
  const persisted = JSON.parse(await evaluate('window.pitchordDesktop.analysisStatus().then(JSON.stringify)'))
  assert.equal(persisted.alignment.models.find(model => model.id === 'small')?.ready, true)
  console.log(JSON.stringify({ oldRoot, pythonVersion: status.pythonVersion, whisperSmall: true, inferredRoot: inferred.root }))
} finally {
  if (before) await evaluate(`window.pitchordDesktop.configureAnalysisEnvironment(${JSON.stringify({ mode: 'managed', root: before.root, computeProfile: before.computeProfile })}).then(JSON.stringify)`)
  socket.close()
  await fs.rm(parent, { recursive: true, force: true })
}
