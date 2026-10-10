const [port = '9348', parent, pythonPath] = process.argv.slice(2)
if (!parent || !pythonPath) throw new Error('Usage: node scripts/smoke-harmony.mjs <port> <project-parent> <python-path>')

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
  const prepared = await window.pitchordDesktop.prepareHarmonyModel('bs-roformer-karaoke-frazer')
  const modelReady = prepared.harmonyModels.find(item => item.id === 'bs-roformer-karaoke-frazer')?.ready
  const project = await window.pitchordDesktop.createProject('Pitchord-harmony-smoke-' + Date.now(), ${JSON.stringify(parent)})
  const sampleRate = 44100
  const sampleCount = sampleRate * 2
  const buffer = new ArrayBuffer(44 + sampleCount * 4)
  const view = new DataView(buffer)
  const write = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  write(0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 4, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, sampleCount * 4, true)
  for (let index = 0; index < sampleCount; index++) {
    const value = Math.sin(2 * Math.PI * 440 * index / sampleRate) * 12000
    view.setInt16(44 + index * 4, value, true)
    view.setInt16(46 + index * 4, value, true)
  }
  const input = await window.pitchordDesktop.storeAsset('vocals', 'test-vocals.wav', buffer)
  const result = await window.pitchordDesktop.separateHarmonies({ vocals: input, model: 'bs-roformer-karaoke-frazer' })
  const activeLead = await window.pitchordDesktop.readProjectAsset('vocals')
  const activeHarmonies = await window.pitchordDesktop.readProjectAsset('harmonies')
  await window.pitchordDesktop.activateVocalResult({ vocals: input })
  const harmonyCleared = (await window.pitchordDesktop.readProjectAsset('harmonies')) === null
  await window.pitchordDesktop.activateVocalResult({ vocals: result.lead.path, harmonies: result.harmonies.path })
  const harmonyRestored = (await window.pitchordDesktop.readProjectAsset('harmonies'))?.data.byteLength > 1000
  const pitch = await window.pitchordDesktop.analyzePitch('pyin', result.lead.path)
  return { directory: project.directory, modelReady, lead: result.lead.path, harmonies: result.harmonies.path,
    leadBytes: activeLead?.data.byteLength || 0, harmonyBytes: activeHarmonies?.data.byteLength || 0, harmonyCleared, harmonyRestored, pitchPoints: pitch.points.length }
})()`

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Harmony smoke test timed out')), 600000)
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

if (!result?.modelReady || result.leadBytes < 1000 || result.harmonyBytes < 1000 || !result.harmonyCleared || !result.harmonyRestored || result.pitchPoints < 50) throw new Error(`Harmony smoke test failed: ${JSON.stringify(result)}`)
console.log(JSON.stringify(result))
