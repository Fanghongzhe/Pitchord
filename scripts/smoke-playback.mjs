const port = process.argv[2] ?? '9290'
const mediaPath = process.argv[3]
if (!mediaPath) throw new Error('Pass a short test video path')

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

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
async function waitFor(expression, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const value = await evaluate(expression)
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

try {
  await call('DOM.enable')
  const document = await call('DOM.getDocument', { depth: -1 })
  const input = await call('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type="file"][accept="audio/*,video/*"]' })
  await call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [mediaPath] })
  await evaluate('document.querySelector(\'input[type="file"][accept="audio/*,video/*"]\').dispatchEvent(new Event("change", { bubbles: true }))')
  await waitFor('document.querySelector("video")?.readyState >= 1')
  await evaluate('window.__smokeVideo = document.querySelector("video"); document.querySelector("video").currentTime = 3')
  const seek = await waitFor('(() => { const line = document.querySelector(".timeline-playhead"); return line && parseFloat(line.style.left) > 300 ? { time: document.querySelector("video").currentTime, left: line.style.left } : null })()')
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("运行人声分离")).click()')
  await waitFor('document.body.innerText.includes("已生成纯人声和纯伴奏")', 120000)
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("纯伴奏 ·")).click()')
  await evaluate('document.querySelector("video").currentTime = 1; void document.querySelector("video").play(); true')
  await new Promise(resolve => setTimeout(resolve, 1200))
  const state = await evaluate('(() => { const video = document.querySelector("video"); const stems = [...document.querySelectorAll("audio")]; const buttons = [...document.querySelectorAll("button")]; return { sameVideo: video === window.__smokeVideo, videoTime: video.currentTime, vocalTime: stems[0]?.currentTime, accompanimentTime: stems[1]?.currentTime, vocalVolume: stems[0]?.volume, accompanimentVolume: stems[1]?.volume, videoMuted: video.muted, stemsPlaying: stems.length === 2 && stems.every(stem => !stem.paused), originalOn: buttons.find(button => button.textContent.includes("原音频 ·"))?.getAttribute("aria-pressed"), vocalsOn: buttons.find(button => button.textContent.includes("纯人声 ·"))?.getAttribute("aria-pressed"), accompanimentOn: buttons.find(button => button.textContent.includes("纯伴奏 ·"))?.getAttribute("aria-pressed") } })()')
  if (!state.sameVideo || !state.stemsPlaying || !state.videoMuted || state.vocalVolume !== 1 || state.accompanimentVolume !== 1 || state.originalOn !== 'false' || state.vocalsOn !== 'true' || state.accompanimentOn !== 'true' || Math.abs(state.videoTime - state.vocalTime) > 0.5 || Math.abs(state.videoTime - state.accompanimentTime) > 0.5) throw new Error(`Playback mixer failed: ${JSON.stringify(state)}`)
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("原音频 ·")).click()')
  const combined = await waitFor('(() => { const video = document.querySelector("video"); return !video.muted && video === window.__smokeVideo ? { videoTime: video.currentTime, allPlaying: [...document.querySelectorAll("audio")].every(stem => !stem.paused) } : null })()')
  if (!combined.allPlaying) throw new Error(`Three-track mix stopped a stem: ${JSON.stringify(combined)}`)
  console.log('Video seeking and audio mixer passed:', JSON.stringify({ seek, state, combined }))
} finally {
  socket.close()
}
