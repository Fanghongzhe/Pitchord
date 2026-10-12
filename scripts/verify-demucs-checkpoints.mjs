import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('./runtime-manifest.json', import.meta.url), 'utf8'))
const checkpoints = [...manifest.demucsCheckpoints.htdemucs, ...manifest.demucsCheckpoints.htdemucs_ft]

for (const checkpoint of checkpoints) {
  const url = `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/${checkpoint.file}`
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`${checkpoint.file}: official source returned HTTP ${response.status}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    hash.update(chunk)
    size += chunk.length
  }
  assert.equal(size, checkpoint.size, `${checkpoint.file}: size mismatch`)
  assert.equal(hash.digest('hex'), checkpoint.sha256, `${checkpoint.file}: SHA-256 mismatch`)
  console.log(`${checkpoint.file}: official SHA-256 verified`)
}
