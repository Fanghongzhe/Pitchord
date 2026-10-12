const fs = require('node:fs')
const path = require('node:path')

function isDirectory(directory) {
  try { return fs.statSync(directory).isDirectory() } catch { return false }
}

function findExistingEnvironment(root, pythonExecutable, preferredVersion) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !isDirectory(root)) throw new Error('请选择已存在的 environment 文件夹。')
  const resolvedRoot = path.resolve(root)
  const runtimes = path.join(resolvedRoot, 'base-runtime')
  const models = path.join(resolvedRoot, 'models')
  if (!isDirectory(runtimes) || !isDirectory(models)) throw new Error('所选目录不是完整的 Pitchord environment 文件夹：需要 base-runtime 和 models 子文件夹。')
  const candidates = fs.readdirSync(runtimes, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('cpython-'))
    .map(entry => ({ name: entry.name, pythonPath: path.join(runtimes, entry.name, 'python', pythonExecutable) }))
    .filter(entry => fs.existsSync(entry.pythonPath))
    .sort((a, b) => a.name === `cpython-${preferredVersion}` ? -1 : b.name === `cpython-${preferredVersion}` ? 1 : b.name.localeCompare(a.name, undefined, { numeric: true }))
  if (!candidates.length) throw new Error('所选 environment 文件夹中没有找到 base-runtime/cpython-*/python/python.exe。')
  return { root: resolvedRoot, pythonPath: candidates[0].pythonPath }
}

function inferExistingEnvironmentFromPython(pythonPath, pythonExecutable, preferredVersion) {
  if (typeof pythonPath !== 'string' || path.basename(pythonPath).toLowerCase() !== pythonExecutable.toLowerCase()) return null
  const pythonDirectory = path.dirname(pythonPath)
  const versionDirectory = path.dirname(pythonDirectory)
  const baseRuntime = path.dirname(versionDirectory)
  if (path.basename(pythonDirectory).toLowerCase() !== 'python' || !path.basename(versionDirectory).startsWith('cpython-') || path.basename(baseRuntime).toLowerCase() !== 'base-runtime') return null
  const root = path.dirname(baseRuntime)
  try {
    const found = findExistingEnvironment(root, pythonExecutable, preferredVersion)
    return { root: found.root, pythonPath: path.resolve(pythonPath) }
  } catch { return null }
}

module.exports = { findExistingEnvironment, inferExistingEnvironmentFromPython }
