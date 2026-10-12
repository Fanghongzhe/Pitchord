const { app, net } = require('electron')
const manifest = require('./runtime-manifest.json')

app.whenReady().then(async () => {
  const catalog = manifest.demucsCheckpoints
  const checkpoint = catalog.htdemucs_ft[0]
  const url = `https://hf-mirror.com/${catalog.repository}/resolve/${catalog.revision}/${checkpoint.file}`
  const response = await net.fetch(url, { headers: { Range: 'bytes=0-1023' } })
  if (!response.ok || !response.body) throw new Error(`HF Mirror returned HTTP ${response.status}`)
  const reader = response.body.getReader()
  const { value } = await reader.read()
  await reader.cancel()
  if (!value?.length) throw new Error('HF Mirror returned no model data')
  console.log(`HF Mirror checkpoint probe passed: HTTP ${response.status}, ${value.length} bytes received`)
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
