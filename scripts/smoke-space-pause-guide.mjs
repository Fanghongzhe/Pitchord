import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-space-pause-guide.mjs <debug-port>')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-space-guide-'))
const project = path.join(root, '空格暂停回归')
await fs.mkdir(path.join(project, 'media'), { recursive: true })
const mediaFile = path.join(project, 'media', 'voice.wav')
await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', mediaFile], { windowsHide: true })
  let error = ''
  child.stderr.on('data', chunk => { error += String(chunk) })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(error.slice(-2000))))
})
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({
  version: 1, projectName: '空格暂停回归', mediaName: 'voice.wav', duration: 6,
  assets: { media: 'media/voice.wav' },
  segments: [{ id: 'line', text: '测试歌词', start: 0, end: 6, chars: [
    { id: 'one', text: '测试', startOffset: 0, endOffset: 2, start: 0, end: 3 },
    { id: 'two', text: '歌词', startOffset: 2, endOffset: 4, start: 3, end: 6 },
  ] }],
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
    if (message.error || message.result?.exceptionDetails) reject(new Error(message.error?.message || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value ?? message.result)
  }
  socket.addEventListener('message', listener)
  socket.send(JSON.stringify({ id: current, method, params }))
})
const evaluate = async expression => {
  try { return await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) }
  catch (error) { throw new Error(`${expression}\n${error.message}`, { cause: error }) }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async expression => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(expression)) return
    await pause(200)
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}
const guideText = () => evaluate(`document.querySelector('[data-guide-line]')?.textContent.trim()`)
const pressSpace = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
}

try {
  await send('Runtime.enable')
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'空格暂停回归',directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await pause(900)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置')?.click()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('空格暂停回归'))?.click()`)
  await waitFor(`!!document.querySelector('[aria-label="句级时间轴"]') && !!document.querySelector('audio')`)
  await waitFor(`document.querySelector('audio').readyState >= 2`)

  await evaluate(`(() => { const ruler = document.querySelector('[aria-label="句级时间轴"] .timeline-ruler'); const rect = ruler.getBoundingClientRect(); ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + rect.width * 0.2, clientY: rect.top + 15 })) })()`)
  await waitFor(`!!document.querySelector('[data-guide-line]')`)
  const guide = await guideText()
  await waitFor(`!document.querySelector('audio').paused`)
  await evaluate(`document.querySelector('audio').currentTime = 2.5`)
  await pressSpace()
  await waitFor(`document.querySelector('audio').paused`)
  assert.equal(await guideText(), guide, 'Space pause moved the split guide')

  await waitFor(`!!document.querySelector('button[aria-label="播放"]')`)
  await evaluate(`document.querySelector('button[aria-label="播放"]').click()`)
  await waitFor(`!document.querySelector('audio').paused`)
  await evaluate(`document.querySelector('audio').currentTime = 3.5`)
  await waitFor(`!!document.querySelector('button[aria-label="暂停"]')`)
  await evaluate(`document.querySelector('button[aria-label="暂停"]').click()`)
  await waitFor(`document.querySelector('audio').paused`)
  assert.equal(await guideText(), guide, 'Player pause moved the split guide')
  console.log(`PASS: Space and player pause both leave ${guide} unchanged`)
} finally {
  socket.close()
  await fs.rm(root, { recursive: true, force: true })
}
