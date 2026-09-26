const port = process.argv[2] ?? '9230'
const targetRoot = process.argv[3]
const profile = process.argv[4] ?? 'cpu'
if (!targetRoot) throw new Error('Usage: node scripts/smoke-install-environment.mjs <port> <target-root> [cpu|cuda121|auto]')

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const result = await new Promise((resolve, reject) => {
  const id = 1
  const listener = event => {
    const message = JSON.parse(event.data)
    if (message.id !== id) return
    socket.removeEventListener('message', listener)
    if (message.error || message.result?.exceptionDetails) reject(new Error(message.error?.message || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  }
  socket.addEventListener('message', listener)
  const request = JSON.stringify({ root: targetRoot, computeProfile: profile })
  socket.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression: `window.pitchordDesktop.installAnalysisRuntime(${request}).then(JSON.stringify)`, awaitPromise: true, returnByValue: true },
  }))
})
socket.close()
const status = JSON.parse(result ?? 'null')
if (!status?.runtimeReady || status.root !== targetRoot || !status.path.startsWith(targetRoot)) throw new Error(`Installed environment is incomplete: ${JSON.stringify(status)}`)
if (profile === 'cpu' && status.compute.backend !== 'cpu') throw new Error(`CPU profile unexpectedly reported ${status.compute.backend}`)
console.log('Managed environment installation passed:', JSON.stringify({ root: status.root, python: status.path, pythonVersion: status.pythonVersion, compute: status.compute.label, packages: status.packages }))
