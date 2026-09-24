const port = process.argv[2] ?? '9229'
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Desktop page did not respond')), 5000)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timeout)
    resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `JSON.stringify({ heading: document.querySelector('h1')?.textContent,
        lines: document.body.textContent?.includes('句级编辑'),
        chars: document.body.textContent?.includes('单字编辑'),
        save: typeof window.pitchordDesktop?.saveText,
        analysisStatus: typeof window.pitchordDesktop?.analysisStatus,
        burnSubtitles: typeof window.pitchordDesktop?.burnSubtitles,
        importModel: typeof window.pitchordDesktop?.importAnalysisModel,
        wordSubtitles: document.body.textContent?.includes('字级字幕与视频'),
        analysisCard: document.querySelector('[data-analysis-environment]') !== null,
        media: document.querySelector('input[type="file"][accept="audio/*,video/*"]') !== null })`,
      returnByValue: true,
    },
  }))
})
socket.close()
const state = JSON.parse(result ?? 'null')
if (state?.heading !== 'Pitchord' || !state.lines || !state.chars || state.save !== 'function' || state.analysisStatus !== 'function' || state.burnSubtitles !== 'function' || state.importModel !== 'function' || !state.wordSubtitles || !state.analysisCard || !state.media) {
  throw new Error(`Desktop UI is incomplete: ${JSON.stringify(state)}`)
}
console.log('Desktop UI loaded:', JSON.stringify(state))
