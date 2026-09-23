import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const [port = '9292', mediaPath, parent] = process.argv.slice(2)
if (!mediaPath || !parent) throw new Error('Usage: node scripts/smoke-project.mjs <port> <media> <project-parent>')
const projectName = `Pitchord-smoke-${Date.now()}`
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Desktop page missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let nextId = 0
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const listener = event => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', listener)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const value = await evaluate(expression)
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`Timed out: ${expression}`)
}
try {
  await evaluate('(() => { window.__stemStarts = 0; const original = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...args) { window.__stemStarts++; return original.apply(this, args) }; return true })()')
  console.log('checking python')
  const python = await evaluate('window.pitchordDesktop.getPython()')
  if (!python?.includes('Pitchord') || !python.endsWith('python.exe')) throw new Error(`Python auto detection failed: ${python}`)
  console.log('opening project dialog')
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("新建项目")).click(); true')
  await waitFor('!!document.querySelector("[role=dialog] input")')
  await evaluate(`(() => { const inputs = [...document.querySelectorAll('[role=dialog] input')]; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(inputs[0], ${JSON.stringify(projectName)}); inputs[0].dispatchEvent(new Event('input', { bubbles: true })); setter.call(inputs[1], ${JSON.stringify(parent)}); inputs[1].dispatchEvent(new Event('input', { bubbles: true })); })()`)
  console.log('creating project')
  await evaluate('[...document.querySelectorAll("[role=dialog] button")].find(button => button.textContent.includes("创建工程")).click(); true')
  await waitFor(`document.body.innerText.includes(${JSON.stringify(projectName)})`)
  await waitFor('!document.querySelector("[role=dialog]")')
  const directory = path.join(parent, projectName)
  if (!existsSync(path.join(directory, 'project.pitchord.json'))) throw new Error('Project manifest missing')
  console.log('loading media')
  await call('DOM.enable')
  const document = await call('DOM.getDocument', { depth: -1 })
  const input = await call('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type="file"][accept="audio/*,video/*"]' })
  await call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [mediaPath] })
  await evaluate('document.querySelector(\'input[type="file"][accept="audio/*,video/*"]\').dispatchEvent(new Event("change", { bubbles: true }))')
  await waitFor('document.querySelector("video")?.readyState >= 1')
  const asset = await waitFor('window.pitchordDesktop.readProjectAsset("media").then(value => value && value.data.length)')
  if (!asset || !existsSync(path.join(directory, 'media', path.basename(mediaPath)))) throw new Error('Media was not saved')
  await evaluate('document.querySelector("video").currentTime = 30')
  const seek = await waitFor('(() => { const viewport = document.querySelector("[aria-label=句级时间轴]"); return viewport && viewport.scrollLeft > 0 ? { left: viewport.scrollLeft, width: viewport.clientWidth } : null })()')
  await evaluate('(() => { const viewport = document.querySelector("[aria-label=句级时间轴]"); viewport.scrollLeft = 0; const video = document.querySelector("video"); video.currentTime = 0; video.playbackRate = 16; void video.play(); return true })()')
  const pageTurn = await waitFor('(() => { const viewport = document.querySelector("[aria-label=句级时间轴]"); return viewport && viewport.scrollLeft >= viewport.clientWidth * .9 ? { left: viewport.scrollLeft, width: viewport.clientWidth } : null })()', 20000)
  await evaluate('document.querySelector("video").pause()')
  const manifest = JSON.parse(readFileSync(path.join(directory, 'project.pitchord.json'), 'utf8'))
  if (!manifest.assets.media || manifest.version !== 1) throw new Error('Project manifest asset missing')
  const lyricDialog = async content => {
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("粘贴歌词")).click(); true')
    await waitFor('!!document.querySelector("[role=dialog] textarea")')
    await evaluate(`(() => { const area = document.querySelector('[role=dialog] textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(area, ${JSON.stringify(content)}); area.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await evaluate('[...document.querySelectorAll("[role=dialog] button")].find(button => button.textContent.includes("导入歌词")).click(); true')
    await waitFor('!document.querySelector("[role=dialog] textarea")')
  }
  await lyricDialog('[00:01.00]第一句\n[00:05.00]第二句')
  await waitFor('document.body.innerText.includes("已导入 2 句")')
  await new Promise(resolve => setTimeout(resolve, 900))
  await lyricDialog('[00:01.00]第一句修改\n[00:05.00]第二句')
  await new Promise(resolve => setTimeout(resolve, 900))
  const lyricDir = path.join(directory, 'lyrics')
  const backups = readdirSync(path.join(lyricDir, 'backups')).filter(file => file.endsWith('.lyrics.json'))
  const sources = readdirSync(path.join(lyricDir, 'sources'))
  if (backups.length < 2 || sources.length < 2 || !readFileSync(path.join(lyricDir, 'current.lrc'), 'utf8').includes('第一句修改')) throw new Error(`Lyrics backups missing: ${JSON.stringify({ backups, sources })}`)
  if (process.argv.includes('--separate')) {
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("运行人声分离")).click(); true')
    await waitFor('document.body.innerText.includes("已生成纯人声和纯伴奏")', 180000)
    const saved = JSON.parse(readFileSync(path.join(directory, 'project.pitchord.json'), 'utf8'))
    if (!saved.assets.vocals || !saved.assets.accompaniment || !existsSync(path.join(directory, saved.assets.vocals)) || !existsSync(path.join(directory, saved.assets.accompaniment))) throw new Error('Separated stems missing from project')
    await evaluate('(() => { const video = document.querySelector("video"); video.playbackRate = 1; video.currentTime = 10; void video.play(); return true })()')
    await new Promise(resolve => setTimeout(resolve, 800))
    const startsBeforeSwitch = await evaluate('window.__stemStarts')
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("纯伴奏 ·")).click(); true')
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("原音频 ·")).click(); true')
    await new Promise(resolve => setTimeout(resolve, 5000))
    const mixer = await evaluate('(() => { const video = document.querySelector("video"); return { videoTime: video.currentTime, videoMuted: video.muted, audioElements: document.querySelectorAll("audio").length, starts: window.__stemStarts, originalOn: [...document.querySelectorAll("button")].find(button => button.textContent.includes("原音频 ·"))?.getAttribute("aria-pressed"), vocalsOn: [...document.querySelectorAll("button")].find(button => button.textContent.includes("纯人声 ·"))?.getAttribute("aria-pressed"), accompanimentOn: [...document.querySelectorAll("button")].find(button => button.textContent.includes("纯伴奏 ·"))?.getAttribute("aria-pressed") } })()')
    if (mixer.videoMuted || mixer.audioElements !== 0 || mixer.starts !== startsBeforeSwitch || mixer.originalOn !== 'true' || mixer.vocalsOn !== 'true' || mixer.accompanimentOn !== 'true') throw new Error(`Mixer switch failed: ${JSON.stringify({ mixer, startsBeforeSwitch })}`)
    await evaluate('document.querySelector("video").pause(); true')
    console.log(JSON.stringify({ directory, python, mediaBytes: asset, seek, pageTurn, assets: saved.assets, backups: backups.length, sources: sources.length, mixer }))
  } else console.log(JSON.stringify({ directory, python, mediaBytes: asset, seek, pageTurn, savedMedia: manifest.assets.media, backups: backups.length, sources: sources.length }))
} finally { socket.close() }
