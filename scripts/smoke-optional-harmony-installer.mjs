const [port = '9353'] = process.argv.slice(2)
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(item => item.type === 'page' && item.url.startsWith('pitchord://app/'))
if (!page) throw new Error('Pitchord desktop page is missing')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const expression = `(async () => {
  const status = await window.pitchordDesktop.analysisStatus()
  const harmony = status.harmonyModels.find(item => item.id === 'bs-roformer-karaoke-frazer')
  const settings = document.querySelector('button[aria-label="设置"]')
  if (!settings) throw new Error('Settings button missing')
  settings.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  await new Promise(resolve => setTimeout(resolve, 100))
  const button = [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent?.trim() === '分析环境')
  if (!button) throw new Error('Analysis environment menu item missing')
  button.click()
  await new Promise(resolve => setTimeout(resolve, 250))
  const label = [...document.querySelectorAll('label')].find(item => item.textContent?.includes('BS-RoFormer Karaoke'))
  const checkbox = label?.querySelector('input[type=checkbox]')
  if (!checkbox) throw new Error('Optional Karaoke checkbox missing')
  const initiallyChecked = checkbox.checked
  checkbox.click()
  await new Promise(resolve => setTimeout(resolve, 100))
  const selected = [...document.querySelectorAll('label')].find(item => item.textContent?.includes('BS-RoFormer Karaoke'))?.querySelector('input[type=checkbox]')?.checked
  const prepared = await window.pitchordDesktop.prepareHarmonyModel('bs-roformer-karaoke-frazer')
  return { runtimeReady: status.runtimeReady, harmonyReady: harmony?.ready, oldManifestSelection: status.installSelection.harmonyModels,
    initiallyChecked, selected, preparedReady: prepared.harmonyModels.find(item => item.id === 'bs-roformer-karaoke-frazer')?.ready }
})()`

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Installer smoke test timed out')), 120000)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timeout)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})
socket.close()
if (!result?.runtimeReady || !result.harmonyReady || result.oldManifestSelection?.length !== 0 || result.initiallyChecked || !result.selected || !result.preparedReady) throw new Error(`Installer smoke test failed: ${JSON.stringify(result)}`)
console.log(JSON.stringify(result))
