import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-global-shift.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-global-shift-'))
const project = path.join(root, '整体偏移回归')
await fs.mkdir(project)
const segments = [3, 6, 9].map((start, index) => ({
  id: `line-${index}`, text: `第${index + 1}句歌词`, start, end: start + 2,
  chars: [{ id: `char-${index}`, text: `第${index + 1}句歌词`, startOffset: 0, endOffset: 5, start, end: start + 2, origin: 'estimated' }],
}))
const pitchPoints = [
  ...Array.from({ length: 20 }, (_, index) => ({ time: 3 + index * 0.05, hz: 220, confidence: 0.9, rms: 0.1, voiced: true })),
  ...Array.from({ length: 20 }, (_, index) => ({ time: 6 + index * 0.05, hz: 880, confidence: 0.9, rms: 0.1, voiced: true })),
]
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({ version: 1, projectName: '整体偏移回归', mediaName: 'song.wav', duration: 20, segments, pitchPoints }))

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
const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async expression => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(expression)) return
    await pause(200)
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}
const click = async label => evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`)
const setInput = async (label, value) => evaluate(`(() => { const input = document.querySelector('input[aria-label=${JSON.stringify(label)}]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
const rowTimes = () => evaluate(`[...document.querySelectorAll('[data-line-id]')].map(row => row.innerText.match(/\\d\\d:\\d\\d\\.\\d{3}/g))`)

try {
  await send('Runtime.enable')
  await evaluate(`localStorage.removeItem('pitchord.pitch-view.v1'); localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'整体偏移回归',directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await pause(800)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('整体偏移回归'))?.click()`)
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 3`)
  if (await evaluate(`!![...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置')`)) await click('稍后设置')
  await click('整体偏移')
  await waitFor(`!!document.querySelector('input[aria-label="整体偏移秒数"]')`)
  await setInput('整体偏移秒数', '1.25')
  await click('应用到全部歌词')
  await waitFor(`document.querySelector('[data-line-id="line-0"]')?.innerText.includes('00:04.250')`)
  assert.equal((await rowTimes())[1][0], '00:07.250')

  await click('整体偏移')
  await click('按第一句校准')
  await setInput('第一句目标开始时间', '00:05.000')
  await click('应用到全部歌词')
  await waitFor(`document.querySelector('[data-line-id="line-0"]')?.innerText.includes('00:05.000')`)
  assert.equal((await rowTimes())[1][0], '00:08.000')

  await click('整体偏移')
  await click('恢复原偏移')
  await waitFor(`document.querySelector('[data-line-id="line-0"]')?.innerText.includes('00:03.000')`)
  assert.equal((await rowTimes())[1][0], '00:06.000')
  await waitFor(`![...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.textContent.includes('整体偏移歌词'))`)
  await evaluate(`document.querySelector('[data-line-id="line-0"]').click()`)
  await waitFor(`![...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent.includes('单字时间与音高'))?.disabled`)
  await click('校对本句的单字时间与音高')
  await waitFor(`!!document.querySelector('[aria-label="字级时间轴"]')`)
  await click('音高视图')
  await waitFor(`!!document.querySelector('[aria-label="音高视图设置"]')`)
  await evaluate(`[...document.querySelectorAll('[aria-label="音高视图设置"] button')].find(button => button.textContent.includes('音名辅助线')).click()`)
  await waitFor(`document.querySelector('[aria-label="字级时间轴"] svg[aria-label="连续音高轨与音高辅助线"]')?.querySelectorAll('line').length > 10`)
  assert.ok(await evaluate(`!!document.querySelector('[aria-label="音高视图设置"] [aria-label="F0 显示下限"]')`))
  await evaluate(`[...document.querySelectorAll('[aria-label="音高视图设置"] button')].find(button => button.textContent.includes('实时适配每句音高范围')).click()`)
  await waitFor(`document.querySelector('[aria-label="音高视图设置"]')?.textContent.includes('F0 显示范围：F3–C#4')`)
  await evaluate(`document.querySelector('[data-line-id="line-1"]').click()`)
  await waitFor(`document.querySelector('[aria-label="音高视图设置"]')?.textContent.includes('F0 显示范围：F5–C#6')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('[aria-label="音高视图设置"] button[aria-pressed="true"]')].some(button => button.textContent.includes('实时适配'))`))
  assert.ok(await evaluate(`!!document.querySelector('[aria-label="音高轨窗口高度"]')`))
  const originalHeight = await evaluate(`document.querySelector('[aria-label="字级时间轴"] svg[aria-label="连续音高轨与音高辅助线"]').getBoundingClientRect().height`)
  await evaluate(`(document.querySelector('[aria-label="音高轨窗口高度"] [role="slider"]') ?? document.querySelector('[aria-label="音高轨窗口高度"]')).focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await waitFor(`document.querySelector('[aria-label="字级时间轴"] svg[aria-label="连续音高轨与音高辅助线"]').getBoundingClientRect().height > ${originalHeight}`)
  await click('返回整句编辑')
  await evaluate(`document.querySelector('[data-line-id="line-0"]').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`)
  await waitFor(`![...document.querySelectorAll('button')].find(button => button.textContent.trim() === '合并')?.disabled`)
  await click('合并')
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 2`)
  await click('校对本句的单字时间与音高')
  await waitFor(`document.querySelector('[aria-label="音高视图设置"]')?.textContent.includes('F0 显示范围：F#3–C6')`)
  await click('返回整句编辑')
  await click('分割')
  await waitFor(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('分割当前歌词'))`)
  await evaluate(`(() => { const input = [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('分割当前歌词')).querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '00:05.500'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('确认分割')
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 3`)
  await click('校对本句的单字时间与音高')
  await waitFor(`document.querySelector('[aria-label="音高视图设置"]')?.textContent.includes('F0 显示范围：F3–C#4')`)
  console.log('Global shift and pitch-view smoke passed: offset, guides, height, line selection, merge and split auto-fitting')
} finally {
  socket.close()
}
