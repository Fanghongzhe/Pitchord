const [port, root] = process.argv.slice(2)
if (!port || !root) throw new Error('Usage: node scripts/smoke-base-runtime.mjs <port> <test-root>')

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const expression = `(async () => {
  await window.pitchordDesktop.configureAnalysisEnvironment({ mode: 'managed', root: ${JSON.stringify(root)}, computeProfile: 'cpu' })
  const status = await window.pitchordDesktop.prepareBaseRuntime()
  return { path: status.path, pythonVersion: status.pythonVersion, root: status.root }
})()`

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Base runtime smoke test timed out')), 360000)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timeout)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})
socket.close()
if (result?.root !== root || !result.path?.endsWith('python.exe') || !result.pythonVersion?.startsWith('3.12.14')) {
  throw new Error(`Base runtime smoke test failed: ${JSON.stringify(result)}`)
}
console.log(JSON.stringify(result))
