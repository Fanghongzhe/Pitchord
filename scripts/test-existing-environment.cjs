const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { findExistingEnvironment, inferExistingEnvironmentFromPython } = require('../electron/existing-environment.cjs')

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchord-existing-environment-'))
try {
  const root = path.join(parent, 'old-portable', 'Pitchord', 'environment')
  const python = path.join(root, 'base-runtime', 'cpython-3.12.14+20260901', 'python', 'python.exe')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.mkdirSync(path.join(root, 'models', 'whisper', 'small'), { recursive: true })
  fs.writeFileSync(python, '')
  assert.deepEqual(findExistingEnvironment(root, 'python.exe', '3.12.14+20260901'), { root, pythonPath: python })
  assert.deepEqual(inferExistingEnvironmentFromPython(python, 'python.exe', '3.12.14+20260901'), { root, pythonPath: python })
  assert.equal(inferExistingEnvironmentFromPython(path.join(parent, 'venv', 'Scripts', 'python.exe'), 'python.exe', '3.12.14+20260901'), null)
  assert.throws(() => findExistingEnvironment(parent, 'python.exe', '3.12.14+20260901'), /base-runtime 和 models/)
  fs.mkdirSync(path.join(root, 'base-runtime', 'cpython-3.11.9', 'python'), { recursive: true })
  fs.writeFileSync(path.join(root, 'base-runtime', 'cpython-3.11.9', 'python', 'python.exe'), '')
  assert.equal(findExistingEnvironment(root, 'python.exe', '3.12.14+20260901').pythonPath, python)
  console.log('Existing environment lookup passed')
} finally {
  fs.rmSync(parent, { recursive: true, force: true })
}
