import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const port = process.argv[2]
if (!port) throw new Error('Usage: node scripts/smoke-repeated-sections.mjs <debug-port>')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-repeat-smoke-'))
const project = path.join(root, '同类段落回归')
await fs.mkdir(path.join(project, 'media'), { recursive: true })
await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18', path.join(project, 'media', 'tone.wav')], { windowsHide: true })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))
})
const spans = [['春风', 0, 2], ['夜雨', 2.2, 4.2], ['春风', 10, 12], ['夜雨呀', 12.2, 14.2]]
const segments = spans.map(([text, start, end], index) => ({ id: `line-${index}`, text, start, end, chars: [...text].map((char, charIndex) => ({
  id: `char-${index}-${charIndex}`, text: char, startOffset: charIndex, endOffset: charIndex + 1, start: start + charIndex * (end - start) / text.length, end: start + (charIndex + 1) * (end - start) / text.length, origin: 'estimated',
  ...(index === 0 && charIndex === 0 ? { pitchOverride: { motion: 'glide', notes: [{ note: 'D4', start: 0, end: 0.5 }, { note: 'C4', start: 0.5, end: 1 }] } } : {}),
})) }))
const pitchPoints = Array.from({ length: 210 }, (_, index) => ({ time: 0.01 + index * 0.02, hz: 440, confidence: 0.9, rms: 0.2, voiced: true }))
await fs.writeFile(path.join(project, 'project.pitchord.json'), JSON.stringify({ version: 1, projectName: '同类段落回归', mediaName: 'tone.wav', duration: 18, assets: { media: 'media/tone.wav' }, segments, pitchPoints }))
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord page missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let id = 0
const errors = []
socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text) })
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const current = ++id
  const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000)
  const listener = event => { const message = JSON.parse(event.data); if (message.id !== current) return; clearTimeout(timer); socket.removeEventListener('message', listener); if (message.error) reject(new Error(message.error.message)); else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text)); else resolve(message.result?.result?.value ?? message.result) }
  socket.addEventListener('message', listener)
  socket.send(JSON.stringify({ id: current, method, params }))
})
const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const waitFor = async expression => { for (let attempt = 0; attempt < 80; attempt++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 250)) } throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText.slice(0, 1200)')}`) }

try {
  await send('Runtime.enable')
  await evaluate(`localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify([{name:'同类段落回归',directory:${JSON.stringify(project)},updatedAt:new Date().toISOString(),available:true}])); location.reload()`)
  await new Promise(resolve => setTimeout(resolve, 900))
  if (await evaluate(`!![...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置')`)) await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '稍后设置').click()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('同类段落回归')).click()`)
  await waitFor(`document.querySelectorAll('[data-line-id]').length >= 4`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '标记段落').click()`)
  await waitFor(`!!document.querySelector('[aria-label="标记同类段落"]')`)
  await evaluate(`document.querySelector('[aria-label="段落歌词句选择"] button').click(); document.querySelectorAll('[aria-label="段落歌词句选择"] button')[1].dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))`)
  await evaluate(`[...document.querySelectorAll('[aria-label="标记同类段落"] button')].find(button => button.textContent.includes('标记 A1')).click()`)
  await waitFor(`document.querySelector('[data-line-id="line-0"]').textContent.includes('A1') && document.querySelector('[data-line-id="line-1"]').textContent.includes('A1')`)
  await evaluate(`document.querySelectorAll('[aria-label="段落歌词句选择"] button')[2].click(); document.querySelectorAll('[aria-label="段落歌词句选择"] button')[3].dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))`)
  await evaluate(`[...document.querySelectorAll('[aria-label="标记同类段落"] button')].find(button => button.textContent.includes('标记 A2')).click()`)
  await waitFor(`document.querySelector('[data-line-id="line-2"]').textContent.includes('A2') && document.querySelector('[data-line-id="line-3"]').textContent.includes('A2')`)
  await evaluate(`[...document.querySelectorAll('[aria-label="标记同类段落"] button')].find(button => button.textContent.trim() === '核对对应关系').click()`)
  await waitFor(`!!document.querySelector('[aria-label="已识别到的同类段落"] [aria-label="目标首句起点"]')`)
  const dialogText = await evaluate(`document.querySelector('[aria-label="已识别到的同类段落"]').textContent`)
  assert.ok(dialogText.includes('春风') && dialogText.includes('夜雨'), dialogText.slice(0, 1600))
  await evaluate(`[...document.querySelectorAll('[aria-label="已识别到的同类段落"] button')].find(button => button.textContent.trim() === '2. 夜雨呀').click()`)
  await waitFor(`document.querySelector('[aria-label="已识别到的同类段落"]').textContent.includes('字／词数不一致')`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="已识别到的同类段落"]').textContent.includes('请核对并确认本句对应')`))
  await evaluate(`[...document.querySelectorAll('[aria-label="已识别到的同类段落"] button')].find(button => button.textContent.trim() === '确认本句对应').click()`)
  await waitFor(`document.querySelector('[aria-label="已识别到的同类段落"]').textContent.includes('已确认本句对应')`)
  await fs.writeFile(path.join(root, 'repeated-sections-dialog.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'))
  assert.ok(await evaluate(`document.querySelectorAll('[aria-label="已识别到的同类段落"] svg path').length > 0`), 'Correspondence connectors are missing')
  await evaluate(`(() => { const input = document.querySelector('[aria-label="已识别到的同类段落"] [aria-label="目标首句起点"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'00:11.000'); input.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await evaluate(`(() => { const input = document.querySelector('[aria-label="已识别到的同类段落"] [aria-label="整体升降调半音"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'2'); input.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await waitFor(`document.querySelector('[aria-label="已识别到的同类段落"]').textContent.includes('同步预览：2 句可更新，0 句需处理')`)
  await evaluate(`[...document.querySelectorAll('[aria-label="已识别到的同类段落"] button')].find(button => button.textContent.includes('确认同步到 A2')).click()`)
  await waitFor(`document.querySelector('[aria-label="已识别到的同类段落"]').textContent.includes('已同步 2 句')`)
  const result = await evaluate(`(() => { const line = document.querySelector('[data-line-id="line-2"]'); return { text: line.textContent, notice: document.querySelector('[role="status"]')?.textContent } })()`)
  assert.ok(result.text.includes('00:11.000'), JSON.stringify(result))
  await evaluate(`[...document.querySelectorAll('[aria-label="已识别到的同类段落"] button')].find(button => button.textContent.trim() === '关闭').click()`)
  await evaluate(`document.querySelector('[data-line-id="line-2"]').click()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('校对本句的单字时间与音高')).click()`)
  await waitFor(`document.body.textContent.includes('E4-D4')`)
  await evaluate(`document.querySelector('[data-clip-id="char-2-0"]').click()`)
  await waitFor(`document.body.textContent.includes('人工结果 · 独立保留')`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '以模型为主').click()`)
  await waitFor(`document.body.textContent.includes('模型建议优先') && document.body.textContent.includes('E4-D4')`)
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '以人工为主').click()`)
  await waitFor(`document.body.textContent.includes('人工结果优先') && document.body.textContent.includes('E4-D4')`)
  await new Promise(resolve => setTimeout(resolve, 900))
  const saved = JSON.parse(await fs.readFile(path.join(project, 'project.pitchord.json'), 'utf8'))
  assert.equal(saved.repeatedSections.length, 2)
  assert.equal(saved.segments[2].start, 11)
  assert.deepEqual(saved.segments[2].chars[0].pitchOverride.notes.map(note => note.note), ['E4', 'D4'])
  assert.equal(saved.segments[2].chars[0].pitchPreference, 'manual')
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '标记段落').click()`)
  await waitFor(`!!document.querySelector('[aria-label="标记同类段落"]')`)
  await evaluate(`document.querySelectorAll('[aria-label="段落歌词句选择"] button')[0].click()`)
  await waitFor(`!!document.querySelector('[aria-label="标记同类段落"] button[aria-label="清除 A1 标记"]')`)
  await evaluate(`document.querySelector('[aria-label="标记同类段落"] button[aria-label="清除 A1 标记"]').click()`)
  await waitFor(`!document.querySelector('[data-line-id="line-0"]').textContent.includes('A1') && document.querySelector('[data-line-id="line-2"]').textContent.includes('A1')`)
  assert.ok(await evaluate(`document.querySelector('[data-line-id="line-2"]').textContent.includes('00:11.000')`), 'Clearing a mark changed lyric timing')
  await evaluate(`[...document.querySelectorAll('[aria-label="标记同类段落"] button')].find(button => button.textContent.trim() === '清除全部标记…').click()`)
  await waitFor(`!![...document.querySelectorAll('[aria-label="标记同类段落"] button')].find(button => button.textContent.trim() === '确认清除全部')`)
  await evaluate(`[...document.querySelectorAll('[aria-label="标记同类段落"] button')].find(button => button.textContent.trim() === '确认清除全部').click()`)
  await waitFor(`![...document.querySelectorAll('[data-line-id]')].some(line => /A[0-9]/.test(line.textContent))`)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result, errors }))
} finally { socket.close(); console.log(`Test fixture: ${project}`) }
