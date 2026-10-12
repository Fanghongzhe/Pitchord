import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-line-list-and-vocal-timeline.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-line-timeline-'))
const project = path.join(root, '句级联动回归')
const vocalSource = path.join(root, 'lead.wav')
await fs.mkdir(project)
const segments = Array.from({ length: 30 }, (_, index) => {
  const text = `第${index + 1}句歌词`
  return { id: `line-${index}`, text, start: index * 3, end: index * 3 + 3, chars: [{ id: `char-${index}`, text, startOffset: 0, endOffset: text.length, start: index * 3, end: index * 3 + 3, origin: 'estimated' }] }
})
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({ version: 1, projectName: '句级联动回归', mediaName: 'song.wav', duration: 90, segments, pitchPoints: [] }))
const sampleRate = 8000
const sampleCount = 90 * sampleRate
const wav = Buffer.alloc(44 + sampleCount * 2)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(sampleRate, 24)
wav.writeUInt32LE(sampleRate * 2, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(sampleCount * 2, 40)
for (let index = 0; index < sampleCount; index++) wav.writeInt16LE(Math.round(6000 * Math.sin(index * 2 * Math.PI * 220 / sampleRate)), 44 + index * 2)
await fs.writeFile(vocalSource, wav)
console.log(`Test root: ${root}`)

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let id = 0
const errors = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const current = ++id
  const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 10000)
  const listener = event => {
    const message = JSON.parse(event.data)
    if (message.id !== current) return
    clearTimeout(timeout)
    socket.removeEventListener('message', listener)
    if (message.error) reject(new Error(message.error.message))
    else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value ?? message.result)
  }
  socket.addEventListener('message', listener)
  socket.send(JSON.stringify({ id: current, method, params }))
})
const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async expression => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(expression)) return
    await pause(250)
  }
  throw new Error(`Timed out waiting for: ${expression}\n${await evaluate('document.body.innerText.slice(0, 1200)')}`)
}
const clickClip = async (lineId, modifiers = 0) => {
  const point = await evaluate(`(() => { const clip = document.querySelector('[data-clip-id="${lineId}"]'); clip.scrollIntoView({ inline: 'center', block: 'nearest' }); const rect = clip.getBoundingClientRect(); const viewport = clip.closest('[aria-label="句级时间轴"]').getBoundingClientRect(); return { x: Math.max(viewport.left + 8, Math.min(rect.left + rect.width / 2, viewport.right - 8)), y: rect.top + rect.height / 2 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers })
  await pause(450)
}
const listState = async lineId => evaluate(`(() => { const row = document.querySelector('[data-line-id="${lineId}"]'); const list = row.parentElement; const a = row.getBoundingClientRect(); const b = list.getBoundingClientRect(); return { selected: row.classList.contains('bg-primary/15'), visible: a.top >= b.top - 1 && a.bottom <= b.bottom + 1, scrollTop: list.scrollTop, rowTop: a.top, rowBottom: a.bottom, listTop: b.top, listBottom: b.bottom, selectedCount: [...list.querySelectorAll('[data-line-id]')].filter(item => item.classList.contains('bg-primary/15')).length } })()`)

try {
  await send('Runtime.enable')
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'句级联动回归',directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await pause(900)
  await waitFor(`!![...document.querySelectorAll('button')].find(button => button.textContent.includes('句级联动回归'))`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('句级联动回归')).click()`)
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 30 && document.querySelectorAll('[data-clip-id]').length === 30`)
  await pause(500)
  if (await evaluate(`!![...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置')`)) await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置').click()`)

  await clickClip('line-24')
  await pause(700)
  const single = await listState('line-24')
  assert.equal(single.selected && single.visible && single.scrollTop > 0, true, `Single select failed: ${JSON.stringify(single)}`)
  await clickClip('line-26', 2)
  const additive = await listState('line-26')
  assert.equal(additive.selected && additive.visible && additive.selectedCount === 2, true, `Additive select failed: ${JSON.stringify(additive)}`)
  await clickClip('line-18', 8)
  const range = await listState('line-18')
  assert.equal(range.selected && range.visible && range.selectedCount === 9, true, `Range select failed: ${JSON.stringify(range)}`)

  const dom = await send('DOM.getDocument')
  const vocalInput = await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: 'input[type="file"][accept="audio/*"]' })
  assert.ok(vocalInput.nodeId, 'Vocal input missing')
  await send('DOM.setFileInputFiles', { nodeId: vocalInput.nodeId, files: [vocalSource] })
  await waitFor(`document.querySelector('[aria-label="句级时间轴"]')?.innerText.includes('纯人声波形 · F0')`)
  await waitFor(`document.querySelector('[aria-label="句级时间轴"]')?.innerText.includes('纯人声频谱')`)
  const spectrogramButton = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '频谱')`
  await evaluate(`${spectrogramButton}.click()`)
  await waitFor(`!document.querySelector('[aria-label="句级时间轴"]')?.innerText.includes('纯人声频谱')`)
  await evaluate(`${spectrogramButton}.click()`)
  await waitFor(`document.querySelector('[aria-label="句级时间轴"]')?.innerText.includes('纯人声频谱')`)
  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent.includes('单字时间与音高')).click()`)
  await waitFor(`document.querySelector('[aria-label="字级时间轴"]')?.innerText.includes('纯人声波形 · F0') && document.querySelector('[aria-label="字级时间轴"]')?.innerText.includes('纯人声频谱')`)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ single, additive, range, vocalWaveformInBothViews: true, spectrogramToggleInBothViews: true, errors }))
} finally {
  socket.close()
}
