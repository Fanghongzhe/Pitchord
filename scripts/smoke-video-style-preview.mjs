import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-video-style-preview.mjs <debug-port>')
const videoSize = process.argv[3] || '640x360'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-video-preview-'))
const project = path.join(root, '视频样式预览回归')
await fs.mkdir(path.join(project, 'media'), { recursive: true })
const videoFile = path.join(project, 'media', 'blue.mp4')
await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=blue:s=${videoSize}:d=3`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoFile], { windowsHide: true })
  let error = ''
  child.stderr.on('data', chunk => { error += String(chunk) })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(error.slice(-3000))))
})
const segments = [{ id: 'line', text: '你好', start: 0, end: 3, chars: [
  { id: 'one', text: '你', startOffset: 0, endOffset: 1, start: 0, end: 1.5 },
  { id: 'two', text: '好', startOffset: 1, endOffset: 2, start: 1.5, end: 3, pitchOverride: { motion: 'flat', notes: [{ note: 'A4', start: 0, end: 1 }] } },
] }]
const pitchPoints = Array.from({ length: 75 }, (_, index) => ({
  time: 0.01 + index * 0.02, hz: index < 34 ? 293.66 : index < 74 ? 261.63 : 246.94,
  confidence: index === 74 ? 0.25 : 0.9, rms: 0.2, voiced: true,
}))
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({
  version: 1, projectName: '视频样式预览回归', mediaName: 'blue.mp4', duration: 3,
  assets: { media: 'media/blue.mp4' }, segments, pitchPoints,
  alignmentResults: [{ id: 'alignment', modelId: 'fixture', modelLabel: 'fixture', createdAt: new Date().toISOString(), coverage: 1, segments }],
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
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(expression)) return
    await pause(250)
  }
  throw new Error(`Timed out waiting for: ${expression}\n${await evaluate('document.body.innerText.slice(0, 1500)')}`)
}

try {
  await send('Runtime.enable')
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'视频样式预览回归',directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await pause(1000)
  if (await evaluate(`!![...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置')`)) await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置').click()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('视频样式预览回归')).click()`)
  await waitFor(`!!document.querySelector('video') && !![...document.querySelectorAll('button')].find(button => button.textContent.includes('调整字幕样式'))`)
  await waitFor(`document.querySelector('video').readyState >= 2`)
  await evaluate(`document.querySelector('video').currentTime = 0.5`)
  await pause(500)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('调整字幕样式')).click()`)
  await waitFor(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('字幕样式、预览与导出'))`)
  await waitFor(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('字幕样式、预览与导出'))?.querySelector('canvas[aria-label="当前视频画面"]')`)
  const frame = await evaluate(`(() => { const dialog = [...document.querySelectorAll('[role="dialog"]')].find(node => node.textContent.includes('字幕样式、预览与导出')); const canvas = dialog.querySelector('canvas[aria-label="当前视频画面"]'); const pixel = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data; const overlay = dialog.querySelector('[aria-label="实时字幕与音高预览"]'); return { width: canvas.width, height: canvas.height, pixel: Array.from(pixel), subtitle: overlay.textContent.includes('你') && overlay.textContent.includes('好'), overlayText: overlay.textContent.slice(0, 100), overlayWidth: overlay.clientWidth, overlayHeight: overlay.clientHeight } })()`)
  assert.ok(frame.width > 0 && frame.height > 0 && frame.pixel[2] > frame.pixel[0] + 100, JSON.stringify(frame))
  assert.ok(frame.subtitle && frame.overlayWidth > 0, JSON.stringify(frame))
  assert.ok(Math.abs(frame.overlayWidth / frame.overlayHeight - frame.width / frame.height) < 0.02, JSON.stringify(frame))
  assert.ok(await evaluate(`!!document.querySelector('[role="dialog"] [aria-label="唱过后保留的音高标记"]')`))
  await evaluate(`document.querySelector('video').currentTime = 1.75`)
  await waitFor(`(() => { const overlay = document.querySelector('[role="dialog"] [aria-label="实时字幕与音高预览"]'); return overlay?.textContent.includes('C4') && overlay?.textContent.includes('A4') })()`)
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.getAttribute('aria-label') === '上左').click()`)
  await pause(200)
  const dialogPosition = await evaluate(`(() => { const overlay = document.querySelector('[role="dialog"] [aria-label="实时字幕与音高预览"]'); const position = overlay.firstElementChild; return { vertical: position.style.alignItems, horizontal: position.style.justifyContent } })()`)
  assert.deepEqual(dialogPosition, { vertical: 'flex-start', horizontal: 'flex-start' })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor(`![...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.textContent.includes('字幕样式、预览与导出'))`)
  const mainPosition = await evaluate(`(() => { const overlay = document.querySelector('.video-preview-frame [aria-label="实时字幕与音高预览"]'); const position = overlay.firstElementChild; return { vertical: position.style.alignItems, horizontal: position.style.justifyContent } })()`)
  assert.deepEqual(mainPosition, dialogPosition)
  const methods = await evaluate(`window.pitchordDesktop.analysisStatus().then(status => status.pitchMethods.map(method => ({ id: method.id, ready: method.ready })))`)
  assert.ok(methods.some(method => method.id === 'rmvpe') && methods.some(method => method.id === 'fcpe'), JSON.stringify(methods))
  const setupText = await evaluate(`document.body.textContent`)
  assert.ok(setupText.includes('RMVPE') && setupText.includes('FCPE'), 'Optional pitch methods are missing from environment setup')
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '全部')?.click()`)
  const checkedPitchModels = await evaluate(`['RMVPE', 'FCPE'].map(name => { const label = [...document.querySelectorAll('[role="dialog"] label')].find(node => node.textContent.includes(name) && node.querySelector('input[type="checkbox"]')); return { name, checked: !!label?.querySelector('input').checked } })`)
  assert.ok(checkedPitchModels.every(model => model.checked), JSON.stringify(checkedPitchModels))
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置')?.click()`)
  await waitFor(`!document.querySelector('[data-state="open"].fixed.inset-0.z-50')`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('悬浮小窗'))?.click()`)
  await waitFor(`!!document.querySelector('[aria-label="视频悬浮小窗"] canvas[aria-label="当前视频画面"]')`)
  await waitFor(`document.querySelector('[aria-label="视频悬浮小窗"] [aria-label="实时字幕与音高预览"]')?.textContent.includes('C4') && document.querySelector('[aria-label="视频悬浮小窗"] [aria-label="实时字幕与音高预览"]')?.textContent.includes('A4')`)
  const popupFrame = await evaluate(`(() => { const panel = document.querySelector('[aria-label="视频悬浮小窗"]'); return { canvas: panel.querySelector('canvas[aria-label="当前视频画面"]')?.width, controls: !!panel.querySelector('[aria-label="小窗播放进度"]') } })()`)
  await waitFor(`(() => { const panel = document.querySelector('[aria-label="视频悬浮小窗"]'); const overlay = panel?.querySelector('[aria-label="实时字幕与音高预览"]'); return overlay && overlay.clientWidth > 300 && Math.abs(overlay.clientWidth / overlay.clientHeight - 640 / 360) < 0.02 })()`)
  assert.ok(popupFrame.canvas > 0 && popupFrame.controls, JSON.stringify(popupFrame))
  await fs.writeFile(path.join(root, 'popup.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'))
  const beforeResize = await evaluate(`(() => { const rect = document.querySelector('[aria-label="视频悬浮小窗"]').getBoundingClientRect(); return { width: rect.width, height: rect.height, x: rect.right - 5, y: rect.bottom - 5 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: beforeResize.x, y: beforeResize.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeResize.x - 70, y: beforeResize.y + 50, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beforeResize.x - 70, y: beforeResize.y + 50, button: 'left', clickCount: 1 })
  await waitFor(`(() => { const rect = document.querySelector('[aria-label="视频悬浮小窗"]').getBoundingClientRect(); return rect.width < ${beforeResize.width - 35} && rect.height > ${beforeResize.height + 25} })()`)
  const beforeDrag = await evaluate(`(() => { const panel = document.querySelector('[aria-label="视频悬浮小窗"]'); const header = panel.firstElementChild.getBoundingClientRect(); return { left: panel.getBoundingClientRect().left, top: panel.getBoundingClientRect().top, x: header.left + 60, y: header.top + header.height / 2 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: beforeDrag.x, y: beforeDrag.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeDrag.x - 70, y: beforeDrag.y + 28, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beforeDrag.x - 70, y: beforeDrag.y + 28, button: 'left', clickCount: 1 })
  await waitFor(`document.querySelector('[aria-label="视频悬浮小窗"]').getBoundingClientRect().left < ${beforeDrag.left - 40}`)
  const beforeBodyDrag = await evaluate(`(() => { const panel = document.querySelector('[aria-label="视频悬浮小窗"]'); const rect = panel.getBoundingClientRect(); return { left: rect.left, top: rect.top, x: rect.left + rect.width / 2, y: rect.top + 90 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: beforeBodyDrag.x, y: beforeBodyDrag.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeBodyDrag.x - 60, y: beforeBodyDrag.y + 25, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeBodyDrag.x - 220, y: beforeBodyDrag.y + 60, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beforeBodyDrag.x - 220, y: beforeBodyDrag.y + 60, button: 'left', clickCount: 1 })
  await waitFor(`document.querySelector('[aria-label="视频悬浮小窗"]').getBoundingClientRect().left < ${beforeBodyDrag.left - 170}`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
  await waitFor(`document.querySelector('video').currentTime < 0.1`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await waitFor(`document.querySelector('video').currentTime > 2.9`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
  await waitFor(`document.querySelector('video').currentTime < 0.1`)
  await evaluate(`document.querySelector('[aria-label="播放小窗预览"]').click()`)
  await waitFor(`!document.querySelector('video').paused && !!document.querySelector('[aria-label="暂停小窗预览"]')`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 8 })
  await waitFor(`document.querySelector('video').currentTime > 0.9 && !document.querySelector('video').paused`)
  await evaluate(`document.querySelector('[aria-label="暂停小窗预览"]').click()`)
  await waitFor(`document.querySelector('video').paused`)
  await evaluate(`document.querySelector('[aria-label="关闭视频小窗"]').click()`)
  await waitFor(`!document.querySelector('[aria-label="视频悬浮小窗"]')`)
  await evaluate(`document.querySelector('video').currentTime = 1.49`)
  await waitFor(`(() => { const overlay = document.querySelector('.video-preview-frame [aria-label="实时字幕与音高预览"]'); const raw = overlay?.querySelector('[aria-label="当前实时音高"]'); return overlay?.textContent.includes('C4') && raw?.textContent.includes('B3') && !overlay.firstElementChild.textContent.includes('B3') })()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('调整字幕样式')).click()`)
  await waitFor(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('字幕样式、预览与导出'))`)
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('生成带字幕视频')).click()`)
  await waitFor(`![...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.textContent.includes('字幕样式、预览与导出'))`)
  const exports = await fs.readdir(path.join(project, 'exports'))
  const assFile = exports.find(name => name.endsWith('.ass'))
  assert.ok(assFile && exports.some(name => name.endsWith('.mp4')), JSON.stringify(exports))
  const ass = await fs.readFile(path.join(project, 'exports', assFile), 'utf8')
  assert.match(ass, /}D4\n/)
  assert.match(ass, /}C4\n/)
  assert.match(ass, /0:00:01\.50,0:00:03\.00,Pitch[^\n]*}C4/)
  assert.ok(!ass.includes('}B3'), 'An unfiltered B3 F0 point leaked into exported lyric labels')
  assert.ok(!ass.includes(',RawPitch,,'), 'Raw F0 must remain optional and disabled by default')
  await evaluate(`document.querySelector('[data-line-id="line"]').click()`)
  await waitFor(`!document.querySelector('video').paused`)
  await evaluate(`document.querySelector('video').pause(); document.querySelector('video').currentTime = 0.9`)
  await waitFor(`document.querySelector('.video-preview-frame [aria-label="实时字幕与音高预览"]').firstElementChild.textContent.includes('C4')`)
  await waitFor(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.includes('校对本句的单字时间与音高')); return button && !button.disabled })()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('校对本句的单字时间与音高')).click()`)
  await waitFor(`!!document.querySelector('[aria-label="字级时间轴"] [data-clip-id="one"]')`)
  await evaluate(`document.querySelector('video').pause(); document.querySelector('video').currentTime = 0.9`)
  await waitFor(`document.querySelector('.video-preview-frame [aria-label="实时字幕与音高预览"]').firstElementChild.textContent.includes('C4')`)
  const boundary = await evaluate(`(() => { const handle = document.querySelector('[aria-label="字级时间轴"] [data-clip-id="one"] .timeline-handle:last-child'); handle.scrollIntoView({ block: 'center', inline: 'center' }); const rect = handle.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: boundary.x, y: boundary.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: boundary.x - 290, y: boundary.y, button: 'left', buttons: 1 })
  await waitFor(`(() => { const lyric = document.querySelector('.video-preview-frame [aria-label="实时字幕与音高预览"]').firstElementChild.textContent; return lyric.includes('D4') && !lyric.includes('C4') })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: boundary.x - 290, y: boundary.y, button: 'left', clickCount: 1 })
  await waitFor(`document.querySelector('[aria-label="字级时间轴"] [data-clip-id="one"]')?.title.includes('00:00.5')`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('调整字幕样式')).click()`)
  await waitFor(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('字幕样式、预览与导出'))`)
  await evaluate(`document.querySelector('video').currentTime = 1.49`)
  await evaluate(`document.querySelector('[role="dialog"] [aria-label="将原始 F0 嵌入视频"]').click()`)
  await evaluate(`document.querySelector('[role="dialog"] [aria-label="原始 F0 下左"]').click()`)
  await waitFor(`(() => { const raw = document.querySelector('[role="dialog"] [aria-label="当前实时音高"]'); return raw?.textContent.includes('F0 B3') && raw?.style.color !== '' && raw?.style.transform.includes('-100%') })()`)
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('生成带字幕视频')).click()`)
  await waitFor(`![...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.textContent.includes('字幕样式、预览与导出'))`)
  const revisedExports = (await fs.readdir(path.join(project, 'exports'))).filter(name => name.endsWith('.ass')).sort()
  assert.equal(revisedExports.length, 2)
  const revisedAss = await fs.readFile(path.join(project, 'exports', revisedExports[1]), 'utf8')
  const revisedLyricPitch = revisedAss.split('\n').filter(line => line.includes(',Pitch,,')).join('\n')
  const revisedRawPitch = revisedAss.split('\n').filter(line => line.includes(',RawPitch,,')).join('\n')
  assert.match(revisedLyricPitch, /}D4/)
  assert.ok(!revisedLyricPitch.includes('}C4') && !revisedLyricPitch.includes('}B3'), 'Export did not follow the revised word boundary')
  assert.match(revisedRawPitch, /\\an1\\pos\(28,1052\)/)
  assert.match(revisedRawPitch, /F0 B3/)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ frame, dialogPosition, mainPosition, popupFrame, methods, checkedPitchModels, assFile, revisedAssFile: revisedExports[1], errors }))
} finally {
  socket.close()
  console.log(`Test fixture: ${project}`)
}
