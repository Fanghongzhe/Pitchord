import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/capture-readme-screenshots.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-readme-demo-'))
const project = path.join(root, 'Pitchord 界面演示')
await fs.mkdir(path.join(project, 'media'), { recursive: true })
await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=392:duration=16', path.join(project, 'media', 'demo-melody.wav')], { windowsHide: true })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))
})
const lines = [
  ['让旋律慢慢发光', 0.8, 7],
  ['每个字都有颜色', 7.5, 14.9],
]
const segments = lines.map(([text, start, end], lineIndex) => ({
  id: `line-${lineIndex}`, text, start, end,
  chars: [...text].map((char, charIndex) => ({
    id: `char-${lineIndex}-${charIndex}`, text: char, startOffset: charIndex, endOffset: charIndex + 1,
    start: Math.round((start + (end - start) * charIndex / text.length) * 1000) / 1000,
    end: Math.round((start + (end - start) * (charIndex + 1) / text.length) * 1000) / 1000,
    origin: 'manual',
  })),
}))
const notes = [392, 440, 493.88, 523.25, 587.33, 523.25, 440, 392, 349.23, 392, 440, 493.88, 523.25, 440]
const pitchPoints = Array.from({ length: 1570 }, (_, index) => {
  const time = index * 0.01
  const note = notes[Math.min(notes.length - 1, Math.floor(time / 1.12))]
  return { time, hz: note * (1 + 0.005 * Math.sin(time * 13)), confidence: 0.96, rms: 0.2, voiced: true }
})
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({
  version: 1, projectName: 'Pitchord 界面演示', mediaName: 'demo-melody.wav', duration: 16,
  assets: { media: 'media/demo-melody.wav', vocals: 'media/demo-melody.wav', accompaniment: 'media/demo-melody.wav' }, segments, pitchPoints,
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
const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const waitFor = async expression => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out: ${expression}`)
}
const saveScreenshot = async filename => {
  const data = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data
  await fs.writeFile(path.join(import.meta.dirname, '..', 'docs', 'screenshots', filename), Buffer.from(data, 'base64'))
}
let recentProjects = null
let pitchSettings = null
try {
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  recentProjects = await evaluate(`localStorage.getItem('pitchord.recent-projects.v1')`)
  pitchSettings = await evaluate(`localStorage.getItem('pitchord.pitch-view.v1')`)
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'Pitchord 界面演示',directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true}])); localStorage.setItem('pitchord.pitch-view.v1', JSON.stringify({ guides:true, density:'natural', autoFitLine:true, lowMidi:60, highMidi:84, waveformGain:1.5, trackHeight:240 })); location.reload()`)
  await new Promise(resolve => setTimeout(resolve, 900))
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('Pitchord 界面演示'))?.click()`)
  await waitFor(`document.querySelectorAll('[data-line-id]').length === 2 && document.querySelector('audio')?.readyState >= 2`)
  await waitFor(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('首次准备分析环境'))`)
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '稍后设置').click()`)
  await waitFor(`!document.querySelector('[role="dialog"]')`)
  await evaluate(`document.querySelector('button[aria-label="收起任务进度"]')?.click()`)
  await evaluate(`document.querySelector('button[aria-label="关闭任务提示"]')?.click()`)
  await evaluate(`(() => { const media = document.querySelector('audio'); media.pause(); media.currentTime = 2.4; media.dispatchEvent(new Event('timeupdate')); window.scrollTo(0, 0) })()`)
  await waitFor(`document.body.textContent.includes('让旋律慢慢发光')`)
  await new Promise(resolve => setTimeout(resolve, 1600))
  await saveScreenshot('workspace-overview.png')
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('校对本句的单字时间与音高')).click()`)
  await waitFor(`!!document.querySelector('[aria-label="字级时间轴"]')`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '音高视图').click()`)
  await waitFor(`!!document.querySelector('[aria-label="音高视图设置"]')`)
  await evaluate(`(() => { const button = [...document.querySelectorAll('[aria-label="音高视图设置"] button')].find(item => item.textContent.includes('音名辅助线')); if (button?.getAttribute('aria-pressed') === 'false') button.click() })()`)
  await evaluate(`document.querySelector('[aria-label="字级时间轴"]').closest('section').scrollIntoView({ block: 'start' })`)
  await saveScreenshot('word-timeline.png')
  console.log('Captured current Pitchord workspace and word-timeline screenshots')
} finally {
  await evaluate(`${recentProjects === null ? "localStorage.removeItem('pitchord.recent-projects.v1')" : `localStorage.setItem('pitchord.recent-projects.v1', ${JSON.stringify(recentProjects)})`}; ${pitchSettings === null ? "localStorage.removeItem('pitchord.pitch-view.v1')" : `localStorage.setItem('pitchord.pitch-view.v1', ${JSON.stringify(pitchSettings)})`}; location.reload()`).catch(() => undefined)
  socket.close()
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  } else console.warn('Demo fixture path was outside the temporary directory; cleanup skipped')
}
