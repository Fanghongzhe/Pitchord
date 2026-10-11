import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-pitch-color-dialog.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-color-ui-'))
const directory = path.join(root, '色带回归测试')
await fs.mkdir(directory)
const text = '你 A 好'
const chars = [
  { id: 'one', text: '你', startOffset: 0, endOffset: 1, start: 0, end: 1, origin: 'estimated' },
  { id: 'two', text: 'A', startOffset: 2, endOffset: 3, start: 1, end: 2, origin: 'estimated' },
  { id: 'three', text: '好', startOffset: 4, endOffset: 5, start: 2, end: 3, origin: 'estimated' },
]
await fs.writeFile(path.join(directory, 'project.pitchord.json'), JSON.stringify({ version: 1, projectName: '色带回归测试', mediaName: 'demo.mp4', duration: 3, segments: [{ id: 'line', text, start: 0, end: 3, chars }], pitchPoints: [
  { time: 0.1, hz: 130.81, confidence: 0.9, rms: 0.2, voiced: true },
  { time: 2.7, hz: 587.33, confidence: 0.9, rms: 0.2, voiced: true },
] }))
console.log(`Test project: ${directory}`)

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Packaged Pitchord page is missing')
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
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate(expression)) return
    await pause(250)
  }
  const state = await evaluate(`({ title: document.title, body: document.body.innerText.slice(0, 1200), dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => node.innerText.slice(0, 120)), buttons: [...document.querySelectorAll('button')].filter(node => node.innerText.includes('字幕导出与视频生成')).map(node => ({ text: node.innerText, disabled: node.disabled })) })`)
  throw new Error(`Timed out waiting for: ${expression}\n${JSON.stringify(state)}`)
}
const click = async selector => {
  const rect = await evaluate(`(() => { const node = ${selector}; if (!node) return null; node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  if (!rect) throw new Error(`UI target missing: ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await pause(200)
}

try {
  await send('Runtime.enable')
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'色带回归测试',directory:${JSON.stringify(directory)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await pause(900)
  if (await evaluate(`!![...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置')`)) await click(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置')`)
  await click(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('色带回归测试'))`)
  await waitFor(`document.body.textContent.includes('字幕导出与视频生成')`)
  await pause(500)
  if (await evaluate(`!![...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置')`)) await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置').click()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '字幕导出与视频生成').click()`)
  await waitFor(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('字幕导出与视频生成'))`)
  await click(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('音高彩虹'))`)
  await waitFor(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('设置歌词音高色带'))`)
  const recognized = await evaluate(`document.body.textContent.includes('C3（130.8 Hz）— D5（587.3 Hz）')`)
  assert.equal(recognized, true)
  await click(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('套用冷／灰／暖三段推荐'))`)
  const recommended = await evaluate(`(() => { const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1); return { intervals: dialog.textContent.match(/区间 [123] ·/g)?.length ?? 0, example: dialog.textContent.includes('[C4, E4)') && dialog.textContent.includes('[E4, D5]') } })()`)
  assert.deepEqual(recommended, { intervals: 3, example: true })
  await click(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('添加音域'))`)
  const count = await evaluate(`[...document.querySelectorAll('[role="dialog"]')].at(-1).textContent.match(/区间 [1234] ·/g)?.length ?? 0`)
  assert.equal(count, 4)
  await click(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '完成')`)
  await waitFor(`![...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.textContent.includes('设置歌词音高色带'))`)
  const back = await evaluate(`(() => { const dialog = document.querySelector('[role="dialog"]'); return { parent: dialog?.textContent.includes('字幕导出与视频生成'), band: [...dialog.querySelectorAll('button')].some(button => button.textContent.includes('分段音域')) } })()`)
  assert.deepEqual(back, { parent: true, band: true })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor(`document.querySelectorAll('[role="dialog"]').length === 0`)
  const pointerEvents = await evaluate(`getComputedStyle(document.body).pointerEvents`)
  assert.equal(pointerEvents, 'auto')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ recognized, recommended, ruleCount: count, back, pointerEvents, errors }))
} finally {
  socket.close()
}
