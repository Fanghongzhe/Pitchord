import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manifest = JSON.parse(await readFile(new URL('./runtime-manifest.json', import.meta.url), 'utf8'))
const catalog = manifest.demucsCheckpoints

test('the accelerated HTDemucs FT source lists every original checkpoint', () => {
  assert.equal(catalog.repository, 'iBoostAI/Demucs-v4')
  assert.match(catalog.revision, /^[a-f0-9]{40}$/)
  assert.equal(catalog.htdemucs.length, 1)
  assert.deepEqual(catalog.htdemucs_ft.map(item => item.file.slice(0, 8)), ['f7e0c4bc', 'd12395a8', '92cfc3b6', '04573f0d'])
  for (const item of [...catalog.htdemucs, ...catalog.htdemucs_ft]) {
    assert.match(item.file, /^[a-f0-9]{8}-[a-f0-9]{8}\.th$/)
    assert.match(item.sha256, /^[a-f0-9]{64}$/)
    assert.equal(item.file.split('-')[1].slice(0, 8), item.sha256.slice(0, 8))
    assert.ok(item.size > 80_000_000 && item.size < 90_000_000)
  }
})
