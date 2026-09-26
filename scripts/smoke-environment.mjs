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
if (!status.root || !status.defaultRoot || !status.computeProfile || !status.runtimePreference) throw new Error(`Environment status is incomplete: ${JSON.stringify(status)}`)
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
await evaluate(`(() => { [...document.querySelectorAll('button')].find(button => /准备分析环境|检查或更换环境/.test(button.textContent))?.click(); return true })()`)
await new Promise(resolve => setTimeout(resolve, 250))
const ui = JSON.parse(await evaluate(`JSON.stringify({
  dialog: document.body.textContent.includes('分析环境设置') || document.body.textContent.includes('首次准备分析环境'),
  managed: document.body.textContent.includes('创建独立环境'),
  custom: document.body.textContent.includes('使用现有 Python'),
  root: document.body.textContent.includes('环境存放位置'),
})`))
socket.close()
if (!Object.values(ui).every(Boolean)) throw new Error(`Environment setup UI is incomplete: ${JSON.stringify(ui)}`)
console.log('Environment setup smoke test passed:', JSON.stringify({ source: status.source, runtimePreference: status.runtimePreference, computeProfile: status.computeProfile, root: status.root, ui }))
