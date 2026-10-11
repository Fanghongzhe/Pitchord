const [port, pythonPath] = process.argv.slice(2)
if (!port || !pythonPath) throw new Error('Usage: node scripts/smoke-harmony-model-download.mjs <port> <python-path>')

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const expression = `(async () => {
  await window.pitchordDesktop.configureAnalysisEnvironment({ mode: 'custom', pythonPath: ${JSON.stringify(pythonPath)} })
  const status = await window.pitchordDesktop.prepareHarmonyModel('bs-roformer-karaoke-frazer')
  return { root: status.root, ready: status.harmonyModels.find(model => model.id === 'bs-roformer-karaoke-frazer')?.ready }
})()`

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Harmony model download smoke test timed out')), 600000)
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
if (!result?.ready) throw new Error(`Harmony model download smoke test failed: ${JSON.stringify(result)}`)
console.log(JSON.stringify(result))
