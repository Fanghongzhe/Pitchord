const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron')
const { writeFile, readdir, readFile, mkdir } = require('node:fs/promises')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')

let ffmpegPath = null
try { ffmpegPath = require('ffmpeg-static') } catch { ffmpegPath = null }
let ffprobePath = null
try { ffprobePath = require('ffprobe-static').path } catch { ffprobePath = null }

protocol.registerSchemesAsPrivileged([{
  scheme: 'pitchord',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

const devUrl = process.env.PITCHORD_DEV_URL
const appRoot = path.resolve(__dirname, '..')
const distRoot = path.join(appRoot, 'dist')
const scriptRoot = app.isPackaged ? path.join(process.resourcesPath, 'scripts') : path.join(appRoot, 'scripts')
let mainWindow
let activeProject = null

const pythonExecutable = process.platform === 'win32' ? 'python.exe' : 'python'
const settingsFile = () => path.join(app.getPath('userData'), 'pitchord-settings.json')
const analysisRuntimeVersion = '1'
const analysisModel = 'htdemucs'
const localDataRoot = () => process.env.LOCALAPPDATA || app.getPath('userData')
const analysisRoot = () => path.join(localDataRoot(), 'Pitchord')
const managedRuntimeRoot = () => path.join(analysisRoot(), 'analysis-runtime', `v${analysisRuntimeVersion}`)
const managedPythonPath = () => path.join(managedRuntimeRoot(), process.platform === 'win32' ? 'Scripts' : 'bin', pythonExecutable)
const modelRoot = () => path.join(analysisRoot(), 'models')
const modelMarker = () => path.join(modelRoot(), 'demucs', `${analysisModel}.json`)
let analysisInstallTask = null

function applicationDirectory() {
  if (!app.isPackaged) return appRoot
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir && path.isAbsolute(portableDir) && fs.existsSync(portableDir)) return portableDir
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE
  if (portableFile && path.isAbsolute(portableFile) && fs.existsSync(portableFile)) return path.dirname(portableFile)
  return path.dirname(process.execPath)
}

function nearbyPythonPaths() {
  const applicationDir = applicationDirectory()
  const roots = [applicationDir, path.dirname(applicationDir), path.dirname(path.dirname(applicationDir)), appRoot]
  return [...new Set(roots)].flatMap(root => ['.venv-analysis', '.venv', 'venv'].map(folder =>
    path.join(root, folder, process.platform === 'win32' ? 'Scripts' : 'bin', pythonExecutable)))
}

async function savedPythonPath() {
  try {
    const settings = JSON.parse(await readFile(settingsFile(), 'utf8'))
    return typeof settings.pythonPath === 'string' && fs.existsSync(settings.pythonPath) ? settings.pythonPath : null
  } catch { return null }
}

async function readSettings() {
  try { return JSON.parse(await readFile(settingsFile(), 'utf8')) } catch { return {} }
}

async function rememberPythonPath(pythonPath) {
  const settings = await readSettings()
  await mkdir(path.dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify({ ...settings, pythonPath, runtimePreference: 'custom' }, null, 2), 'utf8')
}

async function preferManagedRuntime() {
  const settings = await readSettings()
  await mkdir(path.dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify({ ...settings, runtimePreference: 'managed' }, null, 2), 'utf8')
}

async function preferredPythonPath() {
  const settings = await readSettings()
  if (settings.runtimePreference === 'custom' && typeof settings.pythonPath === 'string' && fs.existsSync(settings.pythonPath)) return settings.pythonPath
  const managed = managedPythonPath()
  if (fs.existsSync(managed)) return managed
  const nearby = nearbyPythonPaths().find(candidate => fs.existsSync(candidate))
  if (nearby) return nearby
  const saved = await savedPythonPath()
  if (saved) return saved
  return null
}

function analysisEnvironment(pythonPath) {
  return {
    ...process.env,
    PITCHORD_MODEL_HOME: modelRoot(),
    TORCH_HOME: path.join(modelRoot(), 'torch'),
    HF_HOME: path.join(modelRoot(), 'huggingface'),
    XDG_CACHE_HOME: path.join(modelRoot(), 'cache'),
    PYTHONNOUSERSITE: '1',
    ...(pythonPath ? { PITCHORD_PYTHON: pythonPath } : {}),
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk); options.onOutput?.(String(chunk)) })
    child.stderr?.on('data', chunk => { stderr += String(chunk); options.onOutput?.(String(chunk)) })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout).slice(-4000) || `${command} exited with ${code}`)))
  })
}

async function probePython(pythonPath) {
  if (!pythonPath || (!fs.existsSync(pythonPath) && path.isAbsolute(pythonPath))) return null
  const program = [
    'import json, platform, importlib.util',
    "print(json.dumps({'version': platform.python_version(), 'demucs': bool(importlib.util.find_spec('demucs')), 'torchcrepe': bool(importlib.util.find_spec('torchcrepe')), 'pip': bool(importlib.util.find_spec('pip'))}))",
  ].join(';')
  try {
    const result = await runProcess(pythonPath, ['-c', program], { env: analysisEnvironment(pythonPath) })
    const detail = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
    return { path: pythonPath, ...detail }
  } catch { return null }
}

async function analysisRuntimeStatus() {
  const managedPath = managedPythonPath()
  const selectedPath = await preferredPythonPath()
  const probe = await probePython(selectedPath)
  const source = selectedPath === managedPath ? 'managed' : selectedPath && nearbyPythonPaths().includes(selectedPath) ? 'portable' : selectedPath ? 'custom' : 'missing'
  let modelReady = false
  try { modelReady = JSON.parse(await readFile(modelMarker(), 'utf8')).model === analysisModel } catch { /* not prepared by Pitchord */ }
  return {
    runtimeVersion: analysisRuntimeVersion,
    source,
    path: probe?.path || selectedPath || '',
    pythonVersion: probe?.version || '',
    packages: { demucs: !!probe?.demucs, torchcrepe: !!probe?.torchcrepe, pip: !!probe?.pip },
    runtimeReady: !!(probe?.demucs && probe?.torchcrepe),
    model: analysisModel,
    modelReady,
    runtimeDirectory: managedRuntimeRoot(),
    modelDirectory: modelRoot(),
    busy: !!analysisInstallTask,
  }
}

function sendAnalysisProgress(stage, message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pitchord:analysis-progress', { stage, message })
}

async function findBootstrapPython() {
  const candidates = [...nearbyPythonPaths(), await savedPythonPath(), process.env.PITCHORD_PYTHON, process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    if (candidate === managedPythonPath()) continue
    const args = path.basename(candidate).toLowerCase() === 'py.exe' || candidate === 'py' ? ['-3', '-c', 'import sys; print(sys.executable)'] : ['-c', 'import sys; print(sys.executable)']
    try {
      const result = await runProcess(candidate, args, { env: process.env })
      return { command: candidate, prefix: args[0] === '-3' ? ['-3'] : [], executable: result.stdout.trim().split(/\r?\n/).at(-1) }
    } catch { /* try next candidate */ }
  }
  return null
}

const projectRoot = () => path.join(app.getPath('documents'), 'Pitchord Projects')
const requireProject = () => {
  if (!activeProject) throw new Error('请先新建或打开工程，再导入媒体和运行分析。')
  return activeProject
}
const hasInvalidNameCharacter = name => Array.from(name).some(character => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character))
const safeAssetName = name => Array.from(path.basename(name)).map(character => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character).join('').slice(0, 180)
const projectAssetPath = (project, relative) => {
  const absolute = path.resolve(project.directory, relative)
  if (!absolute.startsWith(project.directory + path.sep)) throw new Error('Invalid project asset path')
  return absolute
}
const lyricPayload = value => JSON.stringify({ version: 1, mediaName: value.mediaName, duration: value.duration, segments: value.segments }, null, 2)
const lrcFromSegments = segments => segments.map(segment => {
  const centiseconds = Math.round(segment.start * 100)
  const minutes = String(Math.floor(centiseconds / 6000)).padStart(2, '0')
  const seconds = String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')
  const fraction = String(centiseconds % 100).padStart(2, '0')
  return `[${minutes}:${seconds}.${fraction}]${segment.text}`
}).join('\n') + (segments.length ? '\n' : '')
async function saveLyricsCopies(project, value, previousManifest) {
  const lyricDir = path.join(project.directory, 'lyrics')
  const backupDir = path.join(lyricDir, 'backups')
  await mkdir(backupDir, { recursive: true })
  const current = path.join(lyricDir, 'current.lyrics.json')
  const nextPayload = lyricPayload(value)
  let priorPayload = null
  try { priorPayload = await readFile(current, 'utf8') } catch { /* first save */ }
  if (priorPayload === nextPayload) return
  const saveSnapshot = async payload => {
    const parsed = JSON.parse(payload)
    if (!parsed.segments?.length) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const hash = createHash('sha256').update(payload).digest('hex').slice(0, 10)
    const base = path.join(backupDir, `${stamp}-${hash}`)
    await writeFile(`${base}.lyrics.json`, payload, 'utf8')
    await writeFile(`${base}.lrc`, lrcFromSegments(parsed.segments), 'utf8')
  }
  if (!priorPayload && previousManifest?.segments?.length) await saveSnapshot(lyricPayload(previousManifest))
  await saveSnapshot(nextPayload)
  const temporary = `${current}.${process.pid}.tmp`
  await writeFile(temporary, nextPayload, 'utf8')
  await fs.promises.rename(temporary, current)
  await writeFile(path.join(lyricDir, 'current.lrc'), lrcFromSegments(value.segments), 'utf8')
}
async function saveProjectManifest(project, content) {
  const value = JSON.parse(content)
  if (value.version !== 1 || !Array.isArray(value.segments)) throw new Error('Invalid project data')
  const target = path.join(project.directory, 'project.pitchord.json')
  let previousManifest = null
  try { previousManifest = JSON.parse(await readFile(target, 'utf8')) } catch { /* new project */ }
  await saveLyricsCopies(project, value, previousManifest)
  const temporary = `${target}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, JSON.stringify({ ...value, name: project.name, assets: project.assets }, null, 2), 'utf8')
  await fs.promises.rename(temporary, target)
  return target
}
function queueProjectSave(project, job) {
  const task = (project.saveQueue || Promise.resolve()).then(job)
  project.saveQueue = task.catch(() => undefined)
  return task
}
async function saveProjectAssets(project) {
  const target = path.join(project.directory, 'project.pitchord.json')
  await queueProjectSave(project, async () => saveProjectManifest(project, await readFile(target, 'utf8')))
}

function createWindow() {
  const window = new BrowserWindow({
    title: 'Pitchord · 歌词时间编辑器',
    width: 1480,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#101216',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (devUrl ? target !== devUrl : !target.startsWith('pitchord://app/')) event.preventDefault()
  })
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadURL('pitchord://app/index.html')
}

app.whenReady().then(() => {
  if (!devUrl) {
    protocol.handle('pitchord', request => {
      const url = new URL(request.url)
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
      const file = path.resolve(distRoot, relative)
      if (!file.startsWith(distRoot + path.sep) && file !== distRoot) return new Response('Forbidden', { status: 403 })
      return net.fetch(pathToFileURL(file).toString())
    })
  }

  ipcMain.handle('pitchord:save-text', async (event, { name, content }) => {
    if (event.sender !== mainWindow?.webContents || typeof name !== 'string' || typeof content !== 'string' ||
        name.length > 240 || content.length > 50_000_000) throw new Error('Invalid save request')
    const safeName = path.basename(name).replace(/[<>:"/\\|?*]/g, '_')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存文件',
      defaultPath: safeName,
      filters: name.endsWith('.lrc') ? [{ name: 'LRC 歌词', extensions: ['lrc'] }] : [{ name: 'Pitchord 项目', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, content, 'utf8')
    return true
  })

  ipcMain.handle('pitchord:get-python', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    return preferredPythonPath()
  })

  ipcMain.handle('pitchord:analysis-status', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    return analysisRuntimeStatus()
  })

  ipcMain.handle('pitchord:install-analysis-runtime', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (analysisInstallTask) throw new Error('分析环境正在执行另一项操作，请稍候。')
    analysisInstallTask = (async () => {
      const bootstrap = await findBootstrapPython()
      if (!bootstrap) throw new Error('未找到可用于创建独立环境的 Python 3。请先在“高级选项”选择已有 Python；后续版本将支持直接下载基础运行时。')
      await mkdir(path.dirname(managedRuntimeRoot()), { recursive: true })
      sendAnalysisProgress('runtime', '正在创建 Pitchord 独立分析环境…')
      await runProcess(bootstrap.command, [...bootstrap.prefix, '-m', 'venv', '--clear', managedRuntimeRoot()], { env: process.env })
      const python = managedPythonPath()
      sendAnalysisProgress('runtime', '正在准备安装工具…')
      await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip'], { env: analysisEnvironment(python) })
      sendAnalysisProgress('runtime', '正在安装人声分离和音高模型依赖，这一步可能需要较长时间…')
      await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--requirement', path.join(scriptRoot, 'analysis-requirements.txt')], {
        env: analysisEnvironment(python),
        onOutput: output => {
          const line = output.trim().split(/\r?\n/).at(-1)
          if (line) sendAnalysisProgress('runtime', line.slice(0, 240))
        },
      })
      const probe = await probePython(python)
      if (!probe?.demucs || !probe?.torchcrepe) throw new Error('依赖安装完成，但环境完整性检查未通过。请再次点击修复。')
      await writeFile(path.join(managedRuntimeRoot(), 'pitchord-runtime.json'), JSON.stringify({ version: analysisRuntimeVersion, createdAt: new Date().toISOString(), bootstrap: bootstrap.executable }, null, 2), 'utf8')
      await preferManagedRuntime()
      sendAnalysisProgress('complete', '分析环境已准备完成。')
      return { ...await analysisRuntimeStatus(), busy: false }
    })()
    try { return await analysisInstallTask } finally { analysisInstallTask = null }
  })

  ipcMain.handle('pitchord:prepare-analysis-model', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (analysisInstallTask) throw new Error('分析环境正在执行另一项操作，请稍候。')
    analysisInstallTask = (async () => {
      const python = await preferredPythonPath()
      const probe = await probePython(python)
      if (!probe?.demucs) throw new Error('请先安装或修复分析环境。')
      await mkdir(path.dirname(modelMarker()), { recursive: true })
      sendAnalysisProgress('model', `正在准备 ${analysisModel} 人声分离模型…`)
      const program = `from demucs.pretrained import get_model; get_model(${JSON.stringify(analysisModel)}); print('ready')`
      await runProcess(python, ['-c', program], {
        env: analysisEnvironment(python),
        onOutput: output => {
          const line = output.trim().split(/\r?\n/).at(-1)
          if (line) sendAnalysisProgress('model', line.slice(0, 240))
        },
      })
      await writeFile(modelMarker(), JSON.stringify({ model: analysisModel, preparedAt: new Date().toISOString() }, null, 2), 'utf8')
      sendAnalysisProgress('complete', '人声分离模型已准备完成。')
      return { ...await analysisRuntimeStatus(), busy: false }
    })()
    try { return await analysisInstallTask } finally { analysisInstallTask = null }
  })

  ipcMain.handle('pitchord:open-analysis-folder', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    await mkdir(analysisRoot(), { recursive: true })
    return shell.openPath(analysisRoot())
  })

  ipcMain.handle('pitchord:pick-python', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const nearby = await preferredPythonPath()
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Python 运行时',
      defaultPath: nearby ? path.dirname(nearby) : applicationDirectory(),
      properties: ['openFile'],
      filters: [{ name: 'Python', extensions: process.platform === 'win32' ? ['exe'] : [''] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    await rememberPythonPath(picked.filePaths[0])
    return picked.filePaths[0]
  })

  ipcMain.handle('pitchord:project-defaults', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    return { parent: projectRoot(), suggestedName: `Pitchord ${new Date().toISOString().slice(0, 10)}` }
  })

  ipcMain.handle('pitchord:pick-project-parent', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const picked = await dialog.showOpenDialog(mainWindow, { title: '选择工程存放位置', defaultPath: activeProject?.directory || projectRoot(), properties: ['openDirectory', 'createDirectory'] })
    return picked.canceled ? null : picked.filePaths[0]
  })

  ipcMain.handle('pitchord:create-project', async (event, { name, parent }) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || name.trim().endsWith('.') || hasInvalidNameCharacter(name)) throw new Error('工程名称包含无效字符。')
    if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw new Error('请选择有效的存放位置。')
    await mkdir(parent, { recursive: true })
    const directory = path.join(parent, name.trim())
    if (fs.existsSync(directory)) throw new Error('同名工程目录已存在，请换一个名称。')
    await mkdir(directory)
    await Promise.all(['media', 'analysis', 'exports', 'lyrics', path.join('lyrics', 'sources'), path.join('lyrics', 'backups')].map(folder => mkdir(path.join(directory, folder), { recursive: true })))
    const project = { directory, name: name.trim(), assets: {} }
    await saveProjectManifest(project, JSON.stringify({ version: 1, mediaName: '', duration: 0, segments: [], pitchPoints: [] }))
    activeProject = project
    return { directory, name: project.name }
  })

  ipcMain.handle('pitchord:open-project', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const picked = await dialog.showOpenDialog(mainWindow, { title: '打开 Pitchord 工程', defaultPath: projectRoot(), properties: ['openFile'], filters: [{ name: 'Pitchord 工程', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePaths[0]) return null
    const file = picked.filePaths[0]
    const content = await readFile(file, 'utf8')
    const value = JSON.parse(content)
    if (value.version !== 1 || !Array.isArray(value.segments)) throw new Error('工程文件格式无效。')
    const directory = path.dirname(file)
    await Promise.all(['media', 'analysis', 'exports', 'lyrics', path.join('lyrics', 'sources'), path.join('lyrics', 'backups')].map(folder => mkdir(path.join(directory, folder), { recursive: true })))
    activeProject = { directory, name: value.name || path.basename(directory), assets: value.assets || {} }
    await queueProjectSave(activeProject, () => saveProjectManifest(activeProject, content))
    return { directory, name: activeProject.name, content }
  })

  ipcMain.handle('pitchord:save-project', async (event, content) => {
    if (event.sender !== mainWindow?.webContents || typeof content !== 'string' || content.length > 50_000_000) throw new Error('Invalid save request')
    const project = requireProject()
    return queueProjectSave(project, () => saveProjectManifest(project, content))
  })

  ipcMain.handle('pitchord:store-lyrics-source', async (event, { name, content }) => {
    if (event.sender !== mainWindow?.webContents || typeof name !== 'string' || typeof content !== 'string' || content.length > 20_000_000) throw new Error('Invalid lyrics source')
    const project = requireProject()
    const safeName = safeAssetName(name || 'pasted.txt')
    const target = path.join(project.directory, 'lyrics', 'sources', `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName}`)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    return target
  })

  ipcMain.handle('pitchord:open-lyrics-folder', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const folder = path.join(requireProject().directory, 'lyrics')
    await mkdir(folder, { recursive: true })
    return shell.openPath(folder)
  })

  ipcMain.handle('pitchord:pick-lyrics-backup', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const project = requireProject()
    const picked = await dialog.showOpenDialog(mainWindow, { title: '恢复歌词备份', defaultPath: path.join(project.directory, 'lyrics', 'backups'), properties: ['openFile'], filters: [{ name: '歌词备份', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePaths[0]) return null
    const file = path.resolve(picked.filePaths[0])
    const lyricDir = path.join(project.directory, 'lyrics')
    if (!file.startsWith(lyricDir + path.sep)) throw new Error('请选择当前工程的歌词备份。')
    return { name: path.basename(file), content: await readFile(file, 'utf8') }
  })

  ipcMain.handle('pitchord:store-asset', async (event, { kind, name, data }) => {
    if (event.sender !== mainWindow?.webContents || !['media', 'vocals', 'accompaniment'].includes(kind) || typeof name !== 'string' || !(data instanceof ArrayBuffer)) throw new Error('Invalid asset request')
    const project = requireProject()
    const folder = kind === 'media' ? 'media' : 'analysis'
    const baseName = `${kind === 'media' ? '' : `${kind}-`}${safeAssetName(name)}`
    const initial = path.join(folder, baseName)
    const relative = fs.existsSync(projectAssetPath(project, initial))
      ? path.join(folder, `${Date.now()}-${baseName}`)
      : initial
    await writeFile(projectAssetPath(project, relative), Buffer.from(data))
    project.assets[kind] = relative
    await saveProjectAssets(project)
    return projectAssetPath(project, relative)
  })

  ipcMain.handle('pitchord:read-project-asset', async (event, kind) => {
    if (event.sender !== mainWindow?.webContents || !['media', 'vocals', 'accompaniment'].includes(kind)) throw new Error('Invalid asset request')
    const project = requireProject()
    const relative = project.assets[kind]
    return relative ? { name: path.basename(relative), data: await readFile(projectAssetPath(project, relative)) } : null
  })

  ipcMain.handle('pitchord:open-project-folder', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    return shell.openPath(requireProject().directory)
  })

  ipcMain.handle('pitchord:separate-vocals', async (event, sourceData) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (!sourceData || typeof sourceData.name !== 'string' || !(sourceData.data instanceof ArrayBuffer)) throw new Error('No source media was provided')
    const project = requireProject()
    const workDir = path.join(project.directory, 'analysis', `separation-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    await mkdir(workDir, { recursive: true })
    const script = path.join(scriptRoot, 'separate-vocals.py')
    const localPython = await preferredPythonPath() || pythonExecutable
    const python = fs.existsSync(localPython) ? localPython : 'python'
    const resolveBundledBinary = (binaryPath, packageName) => {
      if (!app.isPackaged || !binaryPath) return binaryPath
      const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`))
      const relativeBinaryPath = path.relative(packageRoot, binaryPath)
      return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', packageName, relativeBinaryPath)
    }
    const bundledFfmpeg = resolveBundledBinary(ffmpegPath, 'ffmpeg-static')
    const bundledFfprobe = resolveBundledBinary(ffprobePath, 'ffprobe-static')
    const childEnv = analysisEnvironment(python)
    const binaryDirs = [bundledFfmpeg, bundledFfprobe].filter(binary => binary && fs.existsSync(binary)).map(binary => path.dirname(binary))
    if (binaryDirs.length) childEnv.PATH = `${[...new Set(binaryDirs)].join(path.delimiter)}${path.delimiter}${childEnv.PATH || ''}`
    const source = project.assets.media ? projectAssetPath(project, project.assets.media) : path.join(project.directory, 'media', safeAssetName(sourceData.name))
    if (!project.assets.media) {
      await writeFile(source, Buffer.from(sourceData.data))
      project.assets.media = path.relative(project.directory, source)
    }
    await new Promise((resolve, reject) => {
      const child = spawn(python, [script, source, '--output', workDir], { windowsHide: true, env: childEnv })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => {
        if (code === 0) return resolve(undefined)
        const detail = stderr.slice(-3000)
        if (/No module named ['"]demucs['"]/.test(detail)) return reject(new Error('当前 Python 环境没有安装 Demucs。请先安装 Demucs，或在“选择 Python 环境”中选择已安装 Demucs 的 python.exe。'))
        if (/ffmpeg|ffprobe/i.test(detail)) return reject(new Error('处理视频需要 FFmpeg，但当前运行环境无法使用它。请重新安装包含 FFmpeg 的桌面版本。'))
        if (/checkpoint|download|connection|model/i.test(detail)) return reject(new Error(`Demucs 模型或下载失败：${detail}`))
        reject(new Error(detail || `Demucs exited with ${code}`))
      })
    })
    const findVocals = async (folder, filename) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name)
        if (entry.isDirectory()) { const found = await findVocals(full, filename); if (found) return found }
        else if (entry.name.toLowerCase() === filename) return full
      }
      return null
    }
    const vocals = await findVocals(workDir, 'vocals.wav')
    const accompaniment = await findVocals(workDir, 'no_vocals.wav')
    if (!vocals || !accompaniment) throw new Error('Demucs did not produce vocals.wav and no_vocals.wav')
    project.assets.vocals = path.relative(project.directory, vocals)
    project.assets.accompaniment = path.relative(project.directory, accompaniment)
    await mkdir(path.dirname(modelMarker()), { recursive: true })
    await writeFile(modelMarker(), JSON.stringify({ model: analysisModel, preparedAt: new Date().toISOString() }, null, 2), 'utf8')
    await saveProjectAssets(project)
    return { vocals: { name: path.basename(vocals), path: vocals, data: await readFile(vocals) }, accompaniment: { name: path.basename(accompaniment), path: accompaniment, data: await readFile(accompaniment) } }
  })

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
