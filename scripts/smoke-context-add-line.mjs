import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-context-add-line.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-context-add-'))
const project = path.join(root, '右键添加句回归')
await fs.mkdir(path.join(project, 'media'), { recursive: true })
await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', path.join(project, 'media', 'voice.wav')], { windowsHide: true })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))
})
const segments = [['first', '第一句', 2, 3], ['second', '第二句', 7, 8]].map(([id, text, start, end]) => ({
  id, text, start, end, chars: [{ id: `${id}-char`, text, startOffset: 0, endOffset: text.length, start, end, origin: 'estimated' }],
}))
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({
  version: 1, projectName: '右键添加句回归', mediaName: 'voice.wav', duration: 12,
  assets: { media: 'media/voice.wav' }, segments,
}))

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let id = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const current = ++id
  const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 10000)
  const listener = event => {
    const message = JSON.parse(event.data)
    if (message.id !== current) return
    clearTimeout(timeout)
    socket.removeEventListener('message', listener)
    if (message.error || message.result?.exceptionDetails) reject(new Error(message.error?.message || message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value ?? message.result)
  }
  socket.addEventListener('message', listener)
  socket.send(JSON.stringify({ id: current, method, params }))
})
const evaluate = async expression => {
  try { return await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) }
  catch (error) { throw new Error(`${expression}\n${error.message}`, { cause: error }) }
}
const waitFor = async expression => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out: ${expression}`)
}
const rightClickAt = time => evaluate(`(() => {
  const ruler = document.querySelector('[aria-label="句级时间轴"] .timeline-ruler')
  const rect = ruler.getBoundingClientRect()
  ruler.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: rect.left + rect.width * ${time} / 12, clientY: rect.top + 15 }))
})()`)
const addFromMenu = async () => {
  await waitFor(`!!document.querySelector('[role="menu"]')`)
  await evaluate(`[...document.querySelectorAll('[role="menu"] button')].find(button => button.textContent.trim() === '添加句').click()`)
  await waitFor(`!document.querySelector('[role="menu"]')`)
}
const starts = () => evaluate(`[...document.querySelectorAll('[data-line-id]')].map(row => row.textContent.match(/\\d\\d:\\d\\d\\.\\d{3}/)?.[0])`)

try {
  await send('Runtime.enable')
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'右键添加句回归',directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await new Promise(resolve => setTimeout(resolve, 900))
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置')?.click()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('右键添加句回归'))?.click()`)
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 2`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor(`!document.querySelector('[data-line-id="first"]').className.includes('bg-primary/15')`)

  await rightClickAt(0.5)
  await addFromMenu()
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 3`)
  const firstStart = (await starts())[0]
  assert.ok(Math.abs(Number(firstStart.slice(3)) - 0.5) < 0.02, firstStart)
  assert.deepEqual(await starts(), [firstStart, '00:02.000', '00:07.000'])

  await evaluate(`document.querySelector('[data-line-id="first"]').click()`)
  await waitFor(`document.querySelector('[data-line-id="first"]').className.includes('bg-primary/15')`)
  await rightClickAt(0.2)
  await addFromMenu()
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 4`)
  assert.deepEqual(await starts(), [firstStart, '00:02.000', '00:03.000', '00:07.000'])

  await evaluate(`document.querySelector('[data-line-id="second"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 400, clientY: 300 }))`)
  await addFromMenu()
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 5`)
  assert.deepEqual(await starts(), [firstStart, '00:02.000', '00:03.000', '00:07.000', '00:08.000'])

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await evaluate(`document.querySelector('[aria-label="句级时间轴"]').scrollLeft = 200`)
  await rightClickAt(6.4)
  await addFromMenu()
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 6`)
  assert.ok((await starts()).some(time => Math.abs(Number(time.slice(3)) - 6.4) < 0.02), JSON.stringify(await starts()))
  console.log('PASS: selected sentence inserts on its right; otherwise the right-click timeline position is used')
} finally {
  socket.close()
  console.log(`Test fixture: ${project}`)
}
