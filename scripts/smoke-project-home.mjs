import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-project-home.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-home-smoke-'))
const source = path.join(root, '测试歌曲')
await fs.mkdir(path.join(source, 'analysis'), { recursive: true })
await fs.writeFile(path.join(source, 'analysis', 'vocals.wav'), 'test-vocals')
await fs.writeFile(path.join(source, 'project.pitchord.json'), JSON.stringify({
  version: 1, name: '测试歌曲', projectName: '测试歌曲', segments: [],
  separationResults: [{ vocals: path.join(source, 'analysis', 'vocals.wav') }],
}))

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Packaged Pitchord page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let id = 0
const evaluate = expression => new Promise((resolve, reject) => {
  const current = ++id
  const timeout = setTimeout(() => reject(new Error('Desktop operation timed out')), 30000)
  const listener = event => {
    const message = JSON.parse(event.data)
    if (message.id !== current) return
    clearTimeout(timeout)
    socket.removeEventListener('message', listener)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  }
  socket.addEventListener('message', listener)
  socket.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})

try {
  const refreshed = await evaluate(`window.pitchordDesktop.refreshProjects([${JSON.stringify(source)}])`)
  assert.equal(refreshed.find(item => item.directory === source)?.available, true)
  const duplicate = await evaluate(`window.pitchordDesktop.duplicateProject(${JSON.stringify(source)}, '测试歌曲 - 副本')`)
  const copy = JSON.parse(await fs.readFile(path.join(duplicate.directory, 'project.pitchord.json'), 'utf8'))
  assert.equal(copy.separationResults[0].vocals, path.join(duplicate.directory, 'analysis', 'vocals.wav'))
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'测试歌曲',directory:${JSON.stringify(source)},updatedAt:new Date().toISOString(),available:true},{name:'测试歌曲 - 副本',directory:${JSON.stringify(duplicate.directory)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await new Promise(resolve => setTimeout(resolve, 1000))
  const home = await evaluate(`(async () => { const buttons = [...document.querySelectorAll('button')]; const select = buttons.find(button => button.textContent.trim() === '选择'); select?.click(); await new Promise(resolve => setTimeout(resolve, 100)); return { hasRefresh: buttons.some(button => button.textContent.trim() === '刷新'), hasSelect: !!select, hasProject: document.body.innerText.includes('测试歌曲'), selectionVisible: document.body.innerText.includes('全选当前结果') } })()`)
  assert.deepEqual(home, { hasRefresh: true, hasSelect: true, hasProject: true, selectionVisible: true })
  const hidden = await evaluate(`(async () => { const pick = document.querySelector('button[aria-label="选择测试歌曲"]'); pick?.click(); await new Promise(resolve => setTimeout(resolve, 100)); [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '从列表移除')?.click(); await new Promise(resolve => setTimeout(resolve, 100)); [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '刷新')?.click(); await new Promise(resolve => setTimeout(resolve, 300)); return { hidden: JSON.parse(localStorage.getItem('pitchord.hidden-projects.v1') || '[]').includes(${JSON.stringify(source)}), listed: JSON.parse(localStorage.getItem('pitchord.recent-projects.v1') || '[]').some(project => project.directory === ${JSON.stringify(source)}) } })()`)
  assert.deepEqual(hidden, { hidden: true, listed: false })
  assert.equal(await fs.readFile(path.join(source, 'analysis', 'vocals.wav'), 'utf8'), 'test-vocals')
  const trashed = await evaluate(`window.pitchordDesktop.trashProjects([${JSON.stringify(duplicate.directory)}])`)
  assert.deepEqual(trashed.trashed, [duplicate.directory])
  assert.equal(await fs.readFile(path.join(source, 'analysis', 'vocals.wav'), 'utf8'), 'test-vocals')
  await assert.rejects(fs.stat(duplicate.directory), { code: 'ENOENT' })
  console.log(JSON.stringify({ refreshed: true, copied: true, selected: true, removedFromList: true, trashed: true }))
} finally {
  socket.close()
  await fs.rm(root, { recursive: true, force: true })
}
