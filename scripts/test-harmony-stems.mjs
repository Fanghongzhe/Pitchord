import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import harmonyStems from '../electron/harmony-stems.cjs'

const root = mkdtempSync(path.join(tmpdir(), 'pitchord-harmony-stems-'))
mkdirSync(path.join(root, 'input'))
mkdirSync(path.join(root, 'vocals'))
writeFileSync(path.join(root, 'input', 'vocals.wav'), '')
writeFileSync(path.join(root, 'vocals', 'Vocals.wav'), '')
writeFileSync(path.join(root, 'vocals', 'instrumental.wav'), '')

test('finds the MSST lead stem without mistaking the copied input for output', async () => {
  assert.equal(await harmonyStems.findGeneratedStem(root, 'vocals.wav'), path.join(root, 'vocals', 'Vocals.wav'))
})

test('finds the residual harmony stem regardless of filename case', async () => {
  assert.equal(await harmonyStems.findGeneratedStem(root, 'Instrumental.wav'), path.join(root, 'vocals', 'instrumental.wav'))
})

test.after(() => rmSync(root, { recursive: true, force: true }))
