import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pitchInput from '../electron/pitch-input.cjs'

const root = mkdtempSync(path.join(tmpdir(), 'pitchord-pitch-input-'))
const analysis = path.join(root, 'analysis')
mkdirSync(analysis)
const selected = path.join(analysis, 'selected.wav')
const other = path.join(analysis, 'other.wav')
writeFileSync(selected, '')
writeFileSync(other, '')

test('selected separation result works without a saved active vocal asset', () => {
  assert.equal(pitchInput.resolvePitchInput({ directory: root, assets: {} }, selected), selected)
})

test('selected result takes priority over the saved active vocal asset', () => {
  assert.equal(pitchInput.resolvePitchInput({ directory: root, assets: { vocals: path.join('analysis', 'other.wav') } }, selected), selected)
})

test('external vocal import still uses the saved asset', () => {
  assert.equal(pitchInput.resolvePitchInput({ directory: root, assets: { vocals: path.join('analysis', 'other.wav') } }), other)
})

test('rejects files outside the project and missing results', () => {
  assert.throws(() => pitchInput.resolvePitchInput({ directory: root, assets: {} }, path.join(root, 'outside.wav')), /当前工程/)
  assert.throws(() => pitchInput.resolvePitchInput({ directory: root, assets: {} }, path.join(analysis, 'missing.wav')), /不存在/)
})

test.after(() => rmSync(root, { recursive: true, force: true }))
