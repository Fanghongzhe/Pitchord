import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { pitchInstallRequirements, pitchMethodReady, selectedPitchMethodsReady } = require('../electron/pitch-runtime.cjs')

test('FCPE-only setup still installs the common audio dependency', () => {
  assert.deepEqual(pitchInstallRequirements(['fcpe']), ['librosa==1.0.0', 'torchfcpe==0.0.4'])
})

test('FCPE is not reported ready when the common dependency is missing', () => {
  assert.equal(pitchMethodReady({ fcpe: true, librosa: false }, 'fcpe'), false)
  assert.equal(selectedPitchMethodsReady({ fcpe: true, librosa: false }, ['fcpe']), false)
  assert.equal(pitchMethodReady({ fcpe: true, librosa: true }, 'fcpe'), true)
})

test('all pitch methods share the same audio prerequisite', () => {
  for (const method of ['pyin', 'torchcrepe', 'rmvpe', 'fcpe']) {
    assert.equal(pitchMethodReady({ [method]: true, librosa: false }, method), false)
  }
})
