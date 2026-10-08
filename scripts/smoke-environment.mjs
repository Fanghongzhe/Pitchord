import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.argv[2] ?? '9229'
const externalPython = process.argv[3] === '-' ? '' : process.argv[3]
const alternateRoot = process.argv[4]
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const listener = event => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', listener)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

const status = JSON.parse(await evaluate('window.pitchordDesktop.analysisStatus().then(JSON.stringify)'))
if (!status.root || !status.defaultRoot || !status.computeProfile || !status.runtimePreference || typeof status.completeReady !== 'boolean' || !status.installSelection) throw new Error(`Environment status is incomplete: ${JSON.stringify(status)}`)
if (externalPython) {
  try {
    const external = JSON.parse(await evaluate(`window.pitchordDesktop.configureAnalysisEnvironment(${JSON.stringify({ mode: 'custom', pythonPath: externalPython })}).then(JSON.stringify)`))
    if (external.runtimePreference !== 'custom' || !external.path || !external.pythonVersion) throw new Error(`External Python was not selected: ${JSON.stringify(external)}`)
  } finally {
    await evaluate(`window.pitchordDesktop.configureAnalysisEnvironment(${JSON.stringify({ mode: 'managed', root: status.root, computeProfile: status.computeProfile })}).then(JSON.stringify)`)
  }
}
if (alternateRoot) {
  try {
    const alternate = JSON.parse(await evaluate(`window.pitchordDesktop.configureAnalysisEnvironment(${JSON.stringify({ mode: 'managed', root: alternateRoot, computeProfile: 'cpu' })}).then(JSON.stringify)`))
    if (alternate.root !== alternateRoot || alternate.runtimePreference !== 'managed' || alternate.computeProfile !== 'cpu') throw new Error(`Alternate managed root was not selected: ${JSON.stringify(alternate)}`)
  } finally {
    await evaluate(`window.pitchordDesktop.configureAnalysisEnvironment(${JSON.stringify({ mode: 'managed', root: status.root, computeProfile: status.computeProfile })}).then(JSON.stringify)`)
  }
}
let smokeProjectRoot = ''
const environmentControlVisible = await evaluate(`[...document.querySelectorAll('button')].some(button => button.offsetParent && /^(分析环境|准备分析环境|检查或更换环境)$/.test(button.textContent.trim()))`)
if (!environmentControlVisible) {
  smokeProjectRoot = await mkdtemp(join(tmpdir(), 'pitchord-environment-smoke-'))
  await evaluate(`(() => { [...document.querySelectorAll('button')].find(button => button.offsetParent && button.textContent.includes('新建项目'))?.click(); return true })()`)
  await new Promise(resolve => setTimeout(resolve, 250))
  const created = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const inputs = [...(dialog?.querySelectorAll('input') || [])]
    if (inputs.length < 2) return false
    const setValue = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setValue(inputs[0], '环境界面检查')
    setValue(inputs[1], ${JSON.stringify(smokeProjectRoot)})
    ;[...dialog.querySelectorAll('button')].find(button => button.textContent.includes('创建工程'))?.click()
    return true
  })()`)
  if (!created) throw new Error('Could not create an isolated project for the environment UI smoke test')
  await new Promise(resolve => setTimeout(resolve, 500))
}
await evaluate(`(() => {
  if (document.body.textContent.includes('首次准备分析环境') || document.body.textContent.includes('分析环境设置')) return true
  const button = [...document.querySelectorAll('button')].find(item => item.offsetParent && /^(分析环境|准备分析环境|检查或更换环境)$/.test(item.textContent.trim()))
  button?.click()
  return !!button
})()`)
await new Promise(resolve => setTimeout(resolve, 250))
const ui = JSON.parse(await evaluate(`JSON.stringify({
  dialog: document.body.textContent.includes('分析环境设置') || document.body.textContent.includes('首次准备分析环境'),
  managed: document.body.textContent.includes('创建独立环境'),
  custom: document.body.textContent.includes('使用现有 Python'),
  root: document.body.textContent.includes('环境存放位置'),
  presets: document.body.textContent.includes('轻量') && document.body.textContent.includes('推荐') && document.body.textContent.includes('全部'),
  modelChoices: document.body.textContent.includes('TorchCrepe') && document.body.textContent.includes('HTDemucs FT') && document.body.textContent.includes('Whisper Base'),
  backgroundClose: document.body.textContent.includes('关闭此窗口不会取消任务'),
})`))
socket.close()
if (smokeProjectRoot) await rm(smokeProjectRoot, { recursive: true, force: true })
if (!Object.values(ui).every(Boolean)) throw new Error(`Environment setup UI is incomplete: ${JSON.stringify(ui)}`)
console.log('Environment setup smoke test passed:', JSON.stringify({ source: status.source, runtimePreference: status.runtimePreference, computeProfile: status.computeProfile, root: status.root, ui }))
