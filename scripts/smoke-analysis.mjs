const [port = '9336', parent] = process.argv.slice(2)
if (!parent) throw new Error('Usage: node scripts/smoke-analysis.mjs <port> <project-parent>')

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const expression = `(async () => {
  const project = await window.pitchordDesktop.createProject('Pitchord-analysis-smoke-' + Date.now(), ${JSON.stringify(parent)})
  const sampleRate = 22050
  const sampleCount = sampleRate * 2
  const buffer = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buffer)
  const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, sampleCount * 2, true)
  for (let index = 0; index < sampleCount; index++) view.setInt16(44 + index * 2, Math.sin(2 * Math.PI * 440 * index / sampleRate) * 12000, true)
  await window.pitchordDesktop.storeAsset('vocals', 'tone-440.wav', buffer)
  const pyin = await window.pitchordDesktop.analyzePitch('pyin')
  const crepe = await window.pitchordDesktop.analyzePitch('torchcrepe')
  const median = points => {
    const values = points.filter(point => point.voiced).map(point => point.hz).sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]
  }
  return { directory: project.directory, pyinPoints: pyin.points.length, pyinMedian: median(pyin.points), crepePoints: crepe.points.length, crepeMedian: median(crepe.points), workCenter: !!document.querySelector('[data-work-center]') }
})()`

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Analysis smoke test timed out')), 120000)
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

if (!result?.workCenter || result.pyinPoints < 50 || result.crepePoints < 50 || Math.abs(result.pyinMedian - 440) > 5 || Math.abs(result.crepeMedian - 440) > 8) {
  throw new Error(`Analysis smoke test failed: ${JSON.stringify(result)}`)
}
console.log(JSON.stringify(result))
