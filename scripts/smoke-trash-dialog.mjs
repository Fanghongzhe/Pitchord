import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-trash-dialog.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-trash-ui-'))
const project = path.join(root, '待删除测试工程')
const secondProject = path.join(root, '批量删除测试工程')
await fs.mkdir(project)
await fs.mkdir(secondProject)
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({ version: 1, projectName: '待删除测试工程', segments: [] }))
await fs.writeFile(path.join(secondProject, 'project.pitchord.json'), JSON.stringify({ version: 1, projectName: '批量删除测试工程', segments: [] }))
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
const click = async selector => {
  const rect = await evaluate(`(() => { const node = ${selector}; if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: node.textContent } })()`)
  if (!rect) throw new Error(`UI target missing: ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await pause(200)
}

try {
  await send('Runtime.enable')
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'待删除测试工程',directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true},{name:'批量删除测试工程',directory:${JSON.stringify(secondProject)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await pause(1000)
  const setupButton = await evaluate(`!![...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置')`)
  if (setupButton) await click(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置')`)
  await click(`document.querySelector('button[aria-label="待删除测试工程的更多操作"]')`)
  await click(`[...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.includes('移入回收站'))`)
  const dialogOpen = await evaluate(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('将工程移入回收站'))`)
  assert.equal(dialogOpen, true)
  await click(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('移入回收站'))`)
  await pause(700)
  const after = await evaluate(`(() => { const refresh = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '刷新'); const r = refresh.getBoundingClientRect(); return { dialog: !![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('将工程移入回收站')), bodyPointerEvents: getComputedStyle(document.body).pointerEvents, refreshHit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === refresh, listed: JSON.parse(localStorage.getItem('pitchord.recent-projects.v1') || '[]').some(item => item.directory === ${JSON.stringify(project)}), status: document.body.innerText.includes('已移入系统回收站') } })()`)
  console.log(JSON.stringify({ after, errors }))
  assert.equal(after.dialog, false)
  assert.equal(after.listed, false)
  assert.equal(after.refreshHit, true)
  assert.equal(after.bodyPointerEvents, 'auto')
  assert.equal(errors.length, 0)
  await assert.rejects(fs.stat(project), { code: 'ENOENT' })
  await click(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '刷新')`)
  const refreshed = await evaluate(`document.body.innerText.includes('已刷新，找到')`)
  assert.equal(refreshed, true)
  await click(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '选择')`)
  await click(`document.querySelector('button[aria-label="选择批量删除测试工程"]')`)
  await click(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '移入回收站')`)
  await click(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('移入回收站'))`)
  await pause(500)
  const afterBatch = await evaluate(`(() => { const refresh = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '刷新'); const r = refresh.getBoundingClientRect(); return { dialog: !![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('将工程移入回收站')), bodyPointerEvents: getComputedStyle(document.body).pointerEvents, refreshHit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === refresh } })()`)
  console.log(JSON.stringify({ afterBatch, errors }))
  assert.deepEqual(afterBatch, { dialog: false, bodyPointerEvents: 'auto', refreshHit: true })
  await assert.rejects(fs.stat(secondProject), { code: 'ENOENT' })
} finally {
  socket.close()
  await fs.rm(root, { recursive: true, force: true })
}
