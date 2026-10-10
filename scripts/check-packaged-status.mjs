const [port = '9351'] = process.argv.slice(2)
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Status check timed out')), 120000)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timeout)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `(async () => { const status = await window.pitchordDesktop.analysisStatus(); return { runtimeReady: status.runtimeReady, completeReady: status.completeReady, harmonyReady: status.harmonyModels.find(item => item.id === 'bs-roformer-karaoke-frazer')?.ready, runtimePath: status.path, modelRoot: status.modelDirectory } })()`,
    returnByValue: true, awaitPromise: true,
  } }))
})
socket.close()
if (!result?.runtimeReady || !result.completeReady || !result.harmonyReady) throw new Error(`Packaged environment is incomplete: ${JSON.stringify(result)}`)
console.log(JSON.stringify(result))
