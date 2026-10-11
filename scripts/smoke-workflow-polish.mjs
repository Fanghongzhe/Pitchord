const [port = '9355', parent] = process.argv.slice(2)
if (!parent) throw new Error('Usage: node scripts/smoke-workflow-polish.mjs <port> <project-parent>')
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let requestId = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++requestId
  const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 30000)
  const onMessage = event => {
    const response = JSON.parse(event.data)
    if (response.id !== id) return
    socket.removeEventListener('message', onMessage)
    clearTimeout(timeout)
    if (response.error || response.result?.exceptionDetails) reject(new Error(response.error?.message || response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text))
    else resolve(response.result)
  }
  socket.addEventListener('message', onMessage)
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

const created = await evaluate(`(async () => {
  const project = await window.pitchordDesktop.createProject('Pitchord-recent-smoke-' + Date.now(), ${JSON.stringify(parent)})
  localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{ name: project.name, directory: project.directory, updatedAt: new Date().toISOString() }]))
  return project
})()`)
await send('Page.reload', { ignoreCache: true })
await new Promise(resolve => setTimeout(resolve, 750))
const opened = await evaluate(`(async () => {
  const target = ${JSON.stringify(created.name)}
  const card = [...document.querySelectorAll('button')].find(item => item.textContent?.includes(target))
  if (!card) throw new Error('Recent-project card missing')
  card.click()
  for (let index = 0; index < 100 && !document.querySelector('.workspace-header'); index++) await new Promise(resolve => setTimeout(resolve, 100))
  return { workspaceOpen: !!document.querySelector('.workspace-header'), projectName: document.querySelector('.workspace-header')?.textContent?.includes(target) || false }
})()`)
if (!opened?.workspaceOpen || !opened.projectName) throw new Error(`Recent project did not open directly: ${JSON.stringify(opened)}`)

const notified = await evaluate(`(async () => {
  const sampleRate = 44100, sampleCount = sampleRate
  const buffer = new ArrayBuffer(44 + sampleCount * 2), view = new DataView(buffer)
  const write = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
  write(0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 2, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, sampleCount * 2, true)
  for (let index = 0; index < sampleCount; index++) view.setInt16(44 + index * 2, Math.sin(2 * Math.PI * 440 * index / sampleRate) * 8000, true)
  const file = new File([buffer], 'notification-smoke.wav', { type: 'audio/wav' })
  const input = document.querySelector('input[accept="audio/*,video/*"]')
  if (!input) throw new Error('Media input missing')
  const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  for (let index = 0; index < 100; index++) {
    const alert = [...document.querySelectorAll('[role=status]')].find(item => item.textContent?.includes('导入媒体完成'))
    if (alert) return { completedToast: true, text: alert.textContent?.slice(0, 120) }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { completedToast: false }
})()`)
socket.close()
if (!notified?.completedToast) throw new Error(`Task completion popup missing: ${JSON.stringify(notified)}`)
console.log(JSON.stringify({ created, opened, notified }))
