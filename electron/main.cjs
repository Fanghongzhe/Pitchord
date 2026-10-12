const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron')
const { writeFile, readdir, readFile, mkdir } = require('node:fs/promises')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')
const { resolvePitchInput } = require('./pitch-input.cjs')
const { findGeneratedStem } = require('./harmony-stems.cjs')
const { orderedDownloadSources, downloadFromSources } = require('./download-sources.cjs')
const { pitchInstallRequirements, pitchMethodReady, selectedPitchMethodsReady } = require('./pitch-runtime.cjs')
const { validatedProjectDirectory, duplicateProject } = require('./project-operations.cjs')
const { findExistingEnvironment, inferExistingEnvironmentFromPython } = require('./existing-environment.cjs')

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
const msstRoot = app.isPackaged ? path.join(process.resourcesPath, 'vendor', 'msst') : path.join(appRoot, 'vendor', 'msst')
const offlineAnalysisRoot = () => app.isPackaged ? path.join(process.resourcesPath, 'offline-analysis') : path.join(appRoot, 'offline-analysis')
let mainWindow
let activeProject = null
const activeAnalysisTasks = new Map()
const cancellableAnalysisTasks = new Set(['environment', 'separation', 'harmony', 'pitch', 'alignment'])
const pendingTaskCancellations = new Set()

class TaskCancelledError extends Error {
  constructor() {
    super('任务已取消。')
    this.name = 'TaskCancelledError'
  }
}

function isTaskCancelled(error) {
  return error instanceof TaskCancelledError || /任务已取消/.test(error instanceof Error ? error.message : String(error))
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve()
  if (process.platform !== 'win32') {
    child.kill('SIGTERM')
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    killer.once('error', () => { child.kill(); resolve() })
    killer.once('close', () => resolve())
  })
}

function applicationDirectory() {
  if (!app.isPackaged) return appRoot
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir && path.isAbsolute(portableDir) && fs.existsSync(portableDir)) return portableDir
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE
  if (portableFile && path.isAbsolute(portableFile) && fs.existsSync(portableFile)) return path.dirname(portableFile)
  return path.dirname(process.execPath)
}

const portableDataRoot = () => path.join(applicationDirectory(), 'data')
if (app.isPackaged) app.setPath('userData', path.join(portableDataRoot(), 'app-state'))

const pythonExecutable = process.platform === 'win32' ? 'python.exe' : 'python'
const settingsFile = () => path.join(app.getPath('userData'), 'pitchord-settings.json')
const runtimeManifest = JSON.parse(fs.readFileSync(path.join(scriptRoot, 'runtime-manifest.json'), 'utf8'))
const analysisRuntimeVersion = runtimeManifest.analysisRuntimeVersion
const bootstrapInstaller = runtimeManifest.bootstrapInstaller
const demucsCheckpoints = runtimeManifest.demucsCheckpoints || {}
const analysisModel = 'htdemucs'
const separationModelCatalog = [
  { id: 'htdemucs', label: 'HTDemucs', description: '默认平衡方案，首次使用时按需下载模型。', bundled: false },
  { id: 'htdemucs_ft', label: 'HTDemucs FT', description: '微调高质量方案，速度较慢，需要另行准备模型。', bundled: false },
  { id: 'mdx_extra_q', label: 'MDX Extra Q', description: '体积较小、速度较快的量化方案，需要另行准备模型。', bundled: false },
]
const harmonyModelCatalog = [{
  id: 'bs-roformer-karaoke-frazer',
  label: 'BS-RoFormer Karaoke（Frazer / becruily）',
  description: '从已分离的人声中提取主唱，余量保留为和声／残留人声试听轨；贴近主唱的和声仍可能残留，也可能误剥主唱。',
  provider: 'msst', modelType: 'bs_roformer', bundled: false,
  revision: 'f7849ae934209184dc288d1018cd8a76a7fc8b3c',
  repository: 'becruily/bs-roformer-karaoke',
  checkpointName: 'bs_roformer_karaoke_frazer_becruily.ckpt',
  checkpointSha256: 'eb90ee24c1154d83fbcfd27e96182f19e061557cc6e4746953125e08c29389f9',
  checkpointSize: 204436907,
  configName: 'config_karaoke_frazer_becruily.yaml',
  configSha256: '1d3b58b473025183d0d3c91e7a444cb5f1418d9f34e8f46b8d2fb10d2cc8ab34',
  configSize: 1903,
}]
const alignmentModelCatalog = [
  { id: 'small', label: 'Whisper Small', description: '推荐的中英文歌词对齐模型，精度与体积较均衡。', revision: '536b0662742c02347bc0e980a01041f333bce120' },
  { id: 'base', label: 'Whisper Base', description: '下载更小、运行更快，复杂演唱的识别精度较低。', revision: 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66' },
]
const pitchMethodLabels = { pyin: 'pYIN', torchcrepe: 'TorchCrepe', rmvpe: 'RMVPE', fcpe: 'FCPE' }
const rmvpeModel = {
  repository: 'lj1995/VoiceConversionWebUI', revision: 'e6d0c1a17da07c33557852f9dfa2bd44cc75737d',
  filename: 'rmvpe.onnx', sha256: '5370e71ac80af8b4b7c793d27efd51fd8bf962de3a7ede0766dac0befa3660fd', size: 361688443,
}
const rmvpeModelPath = () => path.join(modelRoot(), 'pitch', 'rmvpe', rmvpeModel.filename)
const rmvpeModelMarker = () => path.join(modelRoot(), 'pitch', 'rmvpe', 'pitchord-model.json')
const defaultInstallSelection = {
  pitchMethods: ['pyin', 'torchcrepe'],
  separationModels: ['htdemucs'],
  harmonyModels: [],
  alignmentModels: ['small'],
}

function normalizeInstallSelection(value, requireComplete = false) {
  const source = value && typeof value === 'object' ? value : defaultInstallSelection
  const uniqueSupported = (items, supported) => [...new Set(Array.isArray(items) ? items.filter(item => supported.includes(item)) : [])]
  const selection = {
    pitchMethods: uniqueSupported(source.pitchMethods, Object.keys(pitchMethodLabels)),
    separationModels: uniqueSupported(source.separationModels, separationModelCatalog.map(model => model.id)),
    harmonyModels: uniqueSupported(source.harmonyModels, harmonyModelCatalog.map(model => model.id)),
    alignmentModels: uniqueSupported(source.alignmentModels, alignmentModelCatalog.map(model => model.id)),
  }
  if (!selection.pitchMethods.length || !selection.separationModels.length || !selection.alignmentModels.length) {
    if (requireComplete) throw new Error('音高识别、人声分离和歌词对齐至少需要各选择一项。')
    return { ...defaultInstallSelection, pitchMethods: [...defaultInstallSelection.pitchMethods], separationModels: [...defaultInstallSelection.separationModels], harmonyModels: [], alignmentModels: [...defaultInstallSelection.alignmentModels] }
  }
  return selection
}
const baseRuntime = runtimeManifest.baseRuntime
const legacyAnalysisRoot = () => path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Pitchord')
const defaultAnalysisRoot = () => path.join(applicationDirectory(), 'environment')
let configuredAnalysisRoot = null
const analysisRoot = () => configuredAnalysisRoot || defaultAnalysisRoot()
const baseRuntimeRoot = () => path.join(analysisRoot(), 'base-runtime', `cpython-${baseRuntime.version}`)
const basePythonPath = () => path.join(baseRuntimeRoot(), 'python', pythonExecutable)
const managedRuntimeRoot = () => baseRuntimeRoot()
const managedPythonPath = () => basePythonPath()
const modelRoot = () => path.join(analysisRoot(), 'models')
const modelMarker = (modelId = analysisModel) => path.join(modelRoot(), 'demucs', `${modelId}.json`)
const demucsCheckpointDirectory = () => path.join(modelRoot(), 'torch', 'hub', 'checkpoints')
const demucsCheckpointsPresent = modelId => (demucsCheckpoints[modelId] || []).every(checkpoint => fs.existsSync(path.join(demucsCheckpointDirectory(), checkpoint.file)))
const alignmentModelRoot = () => path.join(modelRoot(), 'whisper')
const alignmentModelDirectory = modelId => path.join(alignmentModelRoot(), modelId)
const alignmentModelMarker = modelId => path.join(alignmentModelDirectory(modelId), 'pitchord-model.json')
const customModelRegistry = () => path.join(modelRoot(), 'custom', 'registry.json')
let analysisInstallTask = null

function readCustomModels() {
  try {
    const value = JSON.parse(fs.readFileSync(customModelRegistry(), 'utf8'))
    if (!Array.isArray(value.models)) return []
    return value.models.map(model => {
      if (model.provider !== 'msst') return model
      const files = Array.isArray(model.files) ? model.files : []
      const checkpointName = files.find(name => /\.ckpt$/i.test(name))
      const configName = files.find(name => /\.ya?ml$/i.test(name))
      const modelType = model.modelType || inferMsstModelType(files)
      const config = model.config || (configName ? path.join(model.directory, configName) : null)
      return {
        ...model,
        modelType,
        checkpoint: model.checkpoint || (checkpointName ? path.join(model.directory, checkpointName) : null),
        config,
        runnable: !!(checkpointName && configName && modelType && config && msstConfigSupportsVocals(config) && fs.existsSync(path.join(msstRoot, 'inference.py'))),
      }
    })
  } catch { return [] }
}

async function writeCustomModels(models) {
  await mkdir(path.dirname(customModelRegistry()), { recursive: true })
  await writeFile(customModelRegistry(), JSON.stringify({ version: 1, models }, null, 2), 'utf8')
}

function separationModel(modelId) {
  const model = [...separationModelCatalog, ...readCustomModels().filter(item => item.kind !== 'harmony' && item.kind !== 'pitch')].find(item => item.id === modelId)
  if (!model) throw new Error('不支持的人声分离模型。')
  if (model.runnable === false) throw new Error('这个模型已纳入 Pitchord 环境，但当前还没有与它匹配的推理提供者或配置。')
  return model
}

function harmonyModel(modelId) {
  const model = [...harmonyModelCatalog.map(item => ({
    ...item,
    checkpoint: path.join(modelRoot(), 'harmony', item.id, item.checkpointName),
    config: path.join(modelRoot(), 'harmony', item.id, item.configName),
  })), ...readCustomModels().filter(item => item.kind === 'harmony')].find(item => item.id === modelId)
  if (!model || model.runnable === false) throw new Error('所选去和声模型不可运行。')
  if (!fs.existsSync(model.checkpoint) || !fs.existsSync(model.config)) throw new Error('请先在模型管理中准备去和声模型。')
  return model
}

function inferMsstModelType(files) {
  const names = files.join(' ').toLowerCase()
  if (/bs[_-]?roformer|model_bs_|bs-resurrection|resurrection/.test(names)) return 'bs_roformer'
  if (/mel[_-]?band|melband|kimmel|kim\.ckpt|big_beta|inst_v1e|kar_gabox|aspiration|denoise|bleed/.test(names)) return 'mel_band_roformer'
  return null
}

function msstConfigSupportsVocals(configPath) {
  try { return /\bvocals\b/i.test(fs.readFileSync(configPath, 'utf8')) } catch { return false }
}

async function listFilesRecursive(directory) {
  const result = []
  let entries = []
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await listFilesRecursive(full))
    else if (entry.isFile()) result.push(path.relative(modelRoot(), full))
  }
  return result
}

function resolveBundledBinary(binaryPath, packageName) {
  if (!app.isPackaged || !binaryPath) return binaryPath
  const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`))
  const relativeBinaryPath = path.relative(packageRoot, binaryPath)
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', packageName, relativeBinaryPath)
}

function nearbyPythonPaths() {
  const applicationDir = applicationDirectory()
  const roots = app.isPackaged ? [applicationDir] : [appRoot]
  return [...new Set(roots)].flatMap(root => ['.venv-analysis', '.venv', 'venv', 'env'].map(folder =>
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

async function writeSettings(patch) {
  const settings = await readSettings()
  await mkdir(path.dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify({ ...settings, ...patch }, null, 2), 'utf8')
}

async function loadAnalysisRoot() {
  const settings = await readSettings()
  if (typeof settings.analysisRoot === 'string' && path.isAbsolute(settings.analysisRoot)) {
    configuredAnalysisRoot = path.resolve(settings.analysisRoot)
    return
  }
  const legacyPython = path.join(legacyAnalysisRoot(), 'base-runtime', `cpython-${baseRuntime.version}`, 'python', pythonExecutable)
  configuredAnalysisRoot = settings.runtimePreference === 'managed' && fs.existsSync(legacyPython)
    ? legacyAnalysisRoot()
    : defaultAnalysisRoot()
}

async function rememberPythonPath(pythonPath) {
  await writeSettings({ pythonPath, runtimePreference: 'custom' })
}

async function preferManagedRuntime(computeProfile) {
  await writeSettings({ analysisRoot: analysisRoot(), runtimePreference: 'managed', computeProfile })
}

async function configuredComputeProfile() {
  const settings = await readSettings()
  return ['auto', 'cpu', 'cuda121'].includes(settings.computeProfile) ? settings.computeProfile : 'auto'
}

async function detectNvidiaGpu() {
  try {
    const result = await runProcess('nvidia-smi.exe', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { env: process.env })
    const first = result.stdout.trim().split(/\r?\n/)[0]
    if (!first) return null
    const [name, driver] = first.split(',').map(value => value.trim())
    return { name, driver }
  } catch { return null }
}

async function preferredPythonPath() {
  const settings = await readSettings()
  if (['custom', 'existing'].includes(settings.runtimePreference) && typeof settings.pythonPath === 'string' && fs.existsSync(settings.pythonPath)) return settings.pythonPath
  const managed = managedPythonPath()
  if (settings.runtimePreference === 'managed') return fs.existsSync(managed) ? managed : null
  if (fs.existsSync(managed)) return managed
  const nearby = nearbyPythonPaths().find(candidate => fs.existsSync(candidate))
  if (nearby) return nearby
  const saved = await savedPythonPath()
  if (saved) return saved
  return null
}

function analysisEnvironment(pythonPath) {
  const torchLibrary = pythonPath && path.isAbsolute(pythonPath) ? path.join(path.dirname(pythonPath), 'Lib', 'site-packages', 'torch', 'lib') : ''
  const environment = {
    ...process.env,
    PITCHORD_MODEL_HOME: modelRoot(),
    TORCH_HOME: path.join(modelRoot(), 'torch'),
    HF_HOME: path.join(modelRoot(), 'huggingface'),
    XDG_CACHE_HOME: path.join(modelRoot(), 'cache'),
    PIP_CACHE_DIR: path.join(analysisRoot(), 'cache', 'pip'),
    PIP_DEFAULT_TIMEOUT: '120',
    UV_CACHE_DIR: path.join(analysisRoot(), 'cache', 'uv'),
    UV_HTTP_TIMEOUT: '120',
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    HF_HUB_VERBOSITY: 'error',
    HF_HUB_DOWNLOAD_TIMEOUT: '120',
    HF_XET_HIGH_PERFORMANCE: '1',
    PATH: torchLibrary && fs.existsSync(torchLibrary) ? `${torchLibrary}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH,
    ...(pythonPath ? { PITCHORD_PYTHON: pythonPath } : {}),
  }
  if (fs.existsSync(modelMarker())) environment.HF_HUB_OFFLINE = '1'
  return environment
}

function offlineBundleAvailable() {
  return fs.existsSync(path.join(offlineAnalysisRoot(), 'manifest.json')) &&
    fs.existsSync(path.join(offlineAnalysisRoot(), 'base-runtime', baseRuntime.archive)) &&
    fs.existsSync(path.join(offlineAnalysisRoot(), 'wheelhouse')) &&
    fs.existsSync(path.join(offlineAnalysisRoot(), 'models', 'demucs', `${analysisModel}.json`)) &&
    fs.existsSync(path.join(offlineAnalysisRoot(), 'models', 'whisper', 'small', 'model.bin'))
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { onOutput, onTransfer, transferPaths = [], taskId, taskTitle, ...spawnOptions } = options
    if (taskId && pendingTaskCancellations.delete(taskId)) return reject(new TaskCancelledError())
    if (taskId && activeAnalysisTasks.has(taskId)) return reject(new Error(`${taskTitle || '分析任务'}已经在运行。`))
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions })
    const task = taskId ? { child, title: taskTitle || taskId, cancelled: false } : null
    if (taskId) activeAnalysisTasks.set(taskId, task)
    let stdout = ''
    let stderr = ''
    let settled = false
    let transferTimer = null
    let transferSample = null
    let transferBaseline = null
    let transferSampling = false
    const sampleTransfer = async () => {
      if (transferSampling || settled || !onTransfer || !transferPaths.length) return
      transferSampling = true
      try {
        const bytes = (await Promise.all(transferPaths.map(directorySize))).reduce((sum, value) => sum + value, 0)
        const sampledAt = Date.now()
        if (transferBaseline === null) transferBaseline = bytes
        if (transferSample && bytes > transferSample.bytes) {
          const seconds = Math.max(0.1, (sampledAt - transferSample.sampledAt) / 1000)
          onTransfer({ speedBytesPerSecond: (bytes - transferSample.bytes) / seconds, downloadedBytes: Math.max(0, bytes - transferBaseline), transferState: 'downloading' })
        }
        transferSample = { bytes, sampledAt }
      } catch { /* progress telemetry must never interrupt an install */ }
      finally { transferSampling = false }
    }
    if (onTransfer && transferPaths.length) {
      void sampleTransfer()
      transferTimer = setInterval(() => { void sampleTransfer() }, 1000)
    }
    const finish = callback => {
      if (settled) return
      settled = true
      if (transferTimer) clearInterval(transferTimer)
      if (taskId && activeAnalysisTasks.get(taskId) === task) activeAnalysisTasks.delete(taskId)
      callback()
    }
    child.stdout?.on('data', chunk => { stdout += String(chunk); onOutput?.(String(chunk)) })
    child.stderr?.on('data', chunk => { stderr += String(chunk); onOutput?.(String(chunk)) })
    child.on('error', error => finish(() => reject(task?.cancelled ? new TaskCancelledError() : error)))
    child.on('close', code => finish(() => {
      if (task?.cancelled) return reject(new TaskCancelledError())
      return code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout).slice(-4000) || `${command} exited with ${code}`))
    }))
  })
}

function readableModelError(error) {
  const raw = error instanceof Error ? error.message : String(error)
  const cleaned = raw.split(/\r?\n/).filter(line => !/unauthenticated requests|HF_TOKEN/i.test(line)).join('\n').trim()
  if (/429|rate limit|too many requests/i.test(cleaned)) return '模型服务当前限制了下载频率，请稍后重试。Pitchord 不要求填写账号 Token。'
  if (/401|403|unauthorized|forbidden/i.test(cleaned)) return '模型服务拒绝了本次下载请求，请检查网络后重试。Pitchord 不要求填写账号 Token。'
  if (/connection|connect|timed?\s*out|network|dns/i.test(cleaned)) return '模型下载连接失败，请检查网络后重试。已经下载的文件会保留并用于续传。'
  return cleaned || '模型准备失败，请检查网络后重试。'
}

async function probePython(pythonPath) {
  if (!pythonPath || (!fs.existsSync(pythonPath) && path.isAbsolute(pythonPath))) return null
  const program = [
    'import json, platform, importlib.util',
    "result = {'version': platform.python_version(), 'demucs': bool(importlib.util.find_spec('demucs')), 'torchcrepe': bool(importlib.util.find_spec('torchcrepe')), 'rmvpe': bool(importlib.util.find_spec('rmvpe_onnx')), 'fcpe': bool(importlib.util.find_spec('torchfcpe')), 'librosa': bool(importlib.util.find_spec('librosa')), 'fasterWhisper': bool(importlib.util.find_spec('faster_whisper')), 'pip': bool(importlib.util.find_spec('pip')), 'torchVersion': '', 'torchBuildCuda': '', 'cudaAvailable': False, 'cudaDeviceCount': 0, 'cudaDeviceName': '', 'ctranslateCudaAvailable': False}",
    "torch_spec = importlib.util.find_spec('torch')",
    "exec(\"import torch\\nresult['torchVersion'] = str(torch.__version__)\\nresult['torchBuildCuda'] = str(torch.version.cuda or '')\\nresult['cudaAvailable'] = bool(torch.cuda.is_available())\\nresult['cudaDeviceCount'] = int(torch.cuda.device_count()) if result['cudaAvailable'] else 0\\nresult['cudaDeviceName'] = torch.cuda.get_device_name(0) if result['cudaAvailable'] else ''\") if torch_spec else None",
    "ctranslate_spec = importlib.util.find_spec('ctranslate2')",
    "exec(\"import ctranslate2\\nresult['ctranslateCudaAvailable'] = bool(ctranslate2.get_cuda_device_count())\") if ctranslate_spec else None",
    'print(json.dumps(result))',
  ].join('\n')
  try {
    const result = await runProcess(pythonPath, ['-c', program], { env: analysisEnvironment(pythonPath) })
    const detail = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
    return { path: pythonPath, ...detail }
  } catch { return null }
}

async function analysisRuntimeStatus() {
  const settings = await readSettings()
  const managedPath = managedPythonPath()
  const selectedPath = await preferredPythonPath()
  const probe = await probePython(selectedPath)
  const baseProbe = await probePython(basePythonPath())
  const source = settings.runtimePreference === 'existing' && selectedPath ? 'existing' : selectedPath === managedPath ? 'managed' : selectedPath && nearbyPythonPaths().includes(selectedPath) ? 'portable' : selectedPath ? 'custom' : 'missing'
  const models = await Promise.all(separationModelCatalog.map(async model => {
    let ready = false
    try { ready = JSON.parse(await readFile(modelMarker(model.id), 'utf8')).model === model.id && demucsCheckpointsPresent(model.id) } catch { /* not prepared by Pitchord */ }
    return { ...model, ready, runnable: true, source: 'recommended', canDelete: !model.bundled, provider: 'demucs' }
  }))
  const customModels = readCustomModels()
  for (const model of customModels.filter(item => item.kind !== 'pitch' && item.kind !== 'harmony')) models.push({ ...model, ready: fs.existsSync(model.directory), source: 'custom', canDelete: true })
  const harmonyModels = harmonyModelCatalog.map(model => {
    const directory = path.join(modelRoot(), 'harmony', model.id)
    let marker = null
    try { marker = JSON.parse(fs.readFileSync(path.join(directory, 'pitchord-model.json'), 'utf8')) } catch { /* not prepared */ }
    return { id: model.id, label: model.label, description: model.description, provider: model.provider, source: 'recommended', canDelete: true,
      ready: marker?.model === model.id && fs.existsSync(path.join(directory, model.checkpointName)) && fs.existsSync(path.join(directory, model.configName)), runnable: true }
  })
  for (const model of customModels.filter(item => item.kind === 'harmony')) harmonyModels.push({ ...model, ready: fs.existsSync(model.directory), source: 'custom', canDelete: true })
  const bundledFfmpeg = resolveBundledBinary(ffmpegPath, 'ffmpeg-static')
  const bundledFfprobe = resolveBundledBinary(ffprobePath, 'ffprobe-static')
  const alignmentModels = alignmentModelCatalog.map(model => ({
    ...model,
    ready: fs.existsSync(alignmentModelMarker(model.id)) && fs.existsSync(path.join(alignmentModelDirectory(model.id), 'model.bin')),
  }))
  let installSelection = normalizeInstallSelection()
  try {
    const manifest = JSON.parse(await readFile(path.join(analysisRoot(), 'pitchord-environment.json'), 'utf8'))
    installSelection = normalizeInstallSelection(manifest.installSelection)
  } catch { /* use the recommended selection for older or custom environments */ }
  let rmvpeReady = false
  try {
    const marker = JSON.parse(await readFile(rmvpeModelMarker(), 'utf8'))
    rmvpeReady = marker.sha256 === rmvpeModel.sha256 && (await fs.promises.stat(rmvpeModelPath())).size === rmvpeModel.size
  } catch { /* model not prepared */ }
  const requiredPackagesReady = (
    (!installSelection.separationModels.length || !!probe?.demucs) &&
    selectedPitchMethodsReady(probe, installSelection.pitchMethods) &&
    (!installSelection.alignmentModels.length || !!probe?.fasterWhisper)
  )
  const selectedSeparationModelsReady = installSelection.separationModels.every(id => models.some(model => model.id === id && model.ready))
  const selectedHarmonyModelsReady = installSelection.harmonyModels.every(id => harmonyModels.some(model => model.id === id && model.ready))
  const selectedAlignmentModelsReady = installSelection.alignmentModels.every(id => alignmentModels.some(model => model.id === id && model.ready))
  const completeReady = requiredPackagesReady && (!installSelection.pitchMethods.includes('rmvpe') || rmvpeReady) && selectedSeparationModelsReady && selectedHarmonyModelsReady && selectedAlignmentModelsReady
  const detectedGpu = await detectNvidiaGpu()
  const computeProfile = await configuredComputeProfile()
  return {
    runtimeVersion: analysisRuntimeVersion,
    source,
    path: probe?.path || selectedPath || '',
    pythonVersion: probe?.version || '',
    root: analysisRoot(),
    defaultRoot: defaultAnalysisRoot(),
    runtimePreference: ['custom', 'existing'].includes(settings.runtimePreference) ? settings.runtimePreference : 'managed',
    computeProfile,
    detectedGpu,
    packages: { demucs: !!probe?.demucs, torchcrepe: !!probe?.torchcrepe, rmvpe: !!probe?.rmvpe, fcpe: !!probe?.fcpe, librosa: !!probe?.librosa, fasterWhisper: !!probe?.fasterWhisper, pip: !!probe?.pip },
    compute: {
      backend: probe?.cudaAvailable ? 'cuda' : 'cpu',
      label: probe?.cudaAvailable ? `${probe.cudaDeviceName || 'CUDA GPU'}（CUDA ${probe.torchBuildCuda || '可用'}）` : 'CPU',
      torchVersion: probe?.torchVersion || '',
      torchBuildCuda: probe?.torchBuildCuda || '',
      cudaAvailable: !!probe?.cudaAvailable,
      cudaDeviceCount: probe?.cudaDeviceCount || 0,
      cudaDeviceName: probe?.cudaDeviceName || '',
      alignmentCudaAvailable: !!probe?.ctranslateCudaAvailable,
    },
    runtimeReady: requiredPackagesReady,
    completeReady,
    mediaTools: { ffmpeg: !!(bundledFfmpeg && fs.existsSync(bundledFfmpeg)), ffprobe: !!(bundledFfprobe && fs.existsSync(bundledFfprobe)) },
    separationModels: models,
    harmonyModels,
    pitchMethods: [
      { id: 'pyin', label: 'pYIN', ready: pitchMethodReady(probe, 'pyin'), description: '概率 YIN 与时间连续性平滑，适合干净纯人声。' },
      { id: 'torchcrepe', label: 'TorchCrepe', ready: pitchMethodReady(probe, 'torchcrepe'), description: '神经网络音高识别，适合复杂唱法和弱基频。' },
      { id: 'rmvpe', label: 'RMVPE', ready: pitchMethodReady(probe, 'rmvpe', rmvpeReady), description: '歌声专用，10ms 音高轨迹；使用独立 ONNX 模型与 CPU 推理。' },
      { id: 'fcpe', label: 'FCPE', ready: pitchMethodReady(probe, 'fcpe'), description: '快速歌声音高模型，10ms 音高轨迹；可使用 GPU。置信度暂不提供校准值。' },
      ...customModels.filter(item => item.kind === 'pitch').map(model => ({ ...model, ready: fs.existsSync(model.directory), source: 'custom', canDelete: true })),
    ],
    alignment: { manual: true, pitchMatching: true, forcedAlignment: !!probe?.fasterWhisper && alignmentModels.some(model => model.ready), models: alignmentModels },
    model: analysisModel,
    modelReady: models.some(model => model.ready),
    installSelection,
    runtimeDirectory: managedRuntimeRoot(),
    modelDirectory: modelRoot(),
    baseRuntimeVersion: baseRuntime.version,
    baseRuntimePath: baseProbe?.path || basePythonPath(),
    baseRuntimeReady: !!baseProbe,
    offlineBundleReady: offlineBundleAvailable(),
    busy: !!analysisInstallTask,
  }
}

async function directorySize(directory) {
  let total = 0
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await directorySize(full)
    else if (entry.isFile()) {
      try { total += (await fs.promises.stat(full)).size } catch { /* file changed while measuring */ }
    }
  }
  return total
}

async function analysisStorageStatus() {
  const locations = {
    baseRuntime: path.join(analysisRoot(), 'base-runtime'),
    analysisRuntime: path.join(analysisRoot(), 'analysis-runtime'),
    models: modelRoot(),
    cache: path.join(analysisRoot(), 'cache'),
    downloads: path.join(analysisRoot(), 'downloads'),
  }
  const sizes = Object.fromEntries(await Promise.all(Object.entries(locations).map(async ([key, value]) => [key, await directorySize(value)])))
  const legacyRoot = path.resolve(legacyAnalysisRoot()) === path.resolve(analysisRoot()) ? '' : legacyAnalysisRoot()
  const legacyTotal = legacyRoot ? await directorySize(legacyRoot) : 0
  return { root: analysisRoot(), locations, sizes, legacyRoot, legacyTotal, total: Object.values(sizes).reduce((sum, value) => sum + value, legacyTotal) }
}

async function removeManagedAnalysisData(target) {
  const legacyTargets = path.resolve(legacyAnalysisRoot()) === path.resolve(analysisRoot()) ? [] : [legacyAnalysisRoot()]
  const targets = {
    runtime: [path.join(analysisRoot(), 'base-runtime'), path.join(analysisRoot(), 'analysis-runtime'), path.join(analysisRoot(), 'pitchord-environment.json')],
    models: [modelRoot()],
    cache: [path.join(analysisRoot(), 'cache'), path.join(analysisRoot(), 'downloads')],
    legacy: legacyTargets,
    all: [path.join(analysisRoot(), 'base-runtime'), path.join(analysisRoot(), 'analysis-runtime'), path.join(analysisRoot(), 'pitchord-environment.json'), modelRoot(), path.join(analysisRoot(), 'cache'), path.join(analysisRoot(), 'downloads'), ...legacyTargets],
  }
  if (!Object.hasOwn(targets, target)) throw new Error('Invalid analysis cleanup target')
  for (const directory of targets[target]) {
    const resolved = path.resolve(directory)
    const root = path.resolve(analysisRoot())
    const legacyRoot = path.resolve(legacyAnalysisRoot())
    if (!resolved.startsWith(root + path.sep) && resolved !== legacyRoot) throw new Error('Invalid managed analysis path')
    await fs.promises.rm(resolved, { recursive: true, force: true })
  }
  return analysisStorageStatus()
}

function sendAnalysisProgress(stage, message, details = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pitchord:analysis-progress', { stage, message, ...details })
}

function sendTaskProgress(id, title, status, message, progress) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pitchord:task-progress', { id, title, status, message, progress })
}

const officialPackageSource = {
  id: 'official',
  label: '官方下载线路',
  pypi: 'https://pypi.org/simple',
  torchBase: 'https://download.pytorch.org/whl',
}
const domesticPackageSource = {
  id: 'domestic',
  label: '国内加速线路（清华 TUNA / 上海交大 SJTUG）',
  pypi: 'https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple',
  torchBase: 'https://mirror.sjtu.edu.cn/pytorch-wheels',
}
const officialModelSource = { id: 'official', label: 'Hugging Face 官方线路', endpoint: 'https://huggingface.co' }
const domesticModelSource = { id: 'domestic', label: '国内模型加速线路（HF Mirror）', endpoint: 'https://hf-mirror.com' }

function torchIndex(source, computeProfile) {
  return `${source.torchBase}/${computeProfile === 'cuda121' ? 'cu121' : 'cpu'}`
}

async function probeDownloadUrl(url, timeout = 2800) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const startedAt = Date.now()
  try {
    const response = await net.fetch(url, { signal: controller.signal, headers: { Range: 'bytes=0-0' } })
    if (!response.ok || !response.body) return Number.POSITIVE_INFINITY
    await response.body.cancel()
    return Date.now() - startedAt
  } catch { return Number.POSITIVE_INFINITY }
  finally { clearTimeout(timer) }
}

async function choosePackageSource(computeProfile) {
  const forced = process.env.PITCHORD_PACKAGE_SOURCE
  if (forced === 'domestic') return domesticPackageSource
  if (forced === 'official') return officialPackageSource
  const measure = async source => {
    const probes = await Promise.all([
      probeDownloadUrl(`${source.pypi}/uv/`),
      probeDownloadUrl(`${torchIndex(source, computeProfile)}/torch/`),
    ])
    return probes.some(value => !Number.isFinite(value)) ? Number.POSITIVE_INFINITY : Math.max(...probes)
  }
  const [domesticLatency, officialLatency] = await Promise.all([measure(domesticPackageSource), measure(officialPackageSource)])
  return Number.isFinite(domesticLatency) && (!Number.isFinite(officialLatency) || domesticLatency <= officialLatency * 1.25)
    ? domesticPackageSource
    : officialPackageSource
}

async function probeModelDownload(source, model, timeout = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const startedAt = Date.now()
  let received = 0
  let reader
  try {
    const repository = `Systran/faster-whisper-${model.id}`
    const response = await net.fetch(`${source.endpoint}/${repository}/resolve/${model.revision}/model.bin`, {
      signal: controller.signal,
      headers: { Range: 'bytes=0-524287' },
    })
    if (!response.ok || !response.body) return 0
    reader = response.body.getReader()
    while (received < 512 * 1024) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
    }
    return received / Math.max(0.1, (Date.now() - startedAt) / 1000)
  } catch { return 0 }
  finally {
    clearTimeout(timer)
    try { await reader?.cancel() } catch { /* probe already ended */ }
  }
}

async function chooseModelSource(model) {
  const forced = process.env.PITCHORD_MODEL_SOURCE
  if (forced === 'domestic') return domesticModelSource
  if (forced === 'official') return officialModelSource
  const [domesticSpeed, officialSpeed] = await Promise.all([
    probeModelDownload(domesticModelSource, model),
    probeModelDownload(officialModelSource, model),
  ])
  return domesticSpeed > 0 && (officialSpeed <= 0 || domesticSpeed >= officialSpeed * 0.8)
    ? domesticModelSource
    : officialModelSource
}

function environmentPlan(computeProfile, packageSource = officialPackageSource, installSelection = defaultInstallSelection) {
  const pitchLabels = installSelection.pitchMethods.map(id => pitchMethodLabels[id] || id).join('、')
  const separationLabels = installSelection.separationModels.map(id => separationModelCatalog.find(model => model.id === id)?.label || id).join('、')
  const harmonyLabels = installSelection.harmonyModels.map(id => harmonyModelCatalog.find(model => model.id === id)?.label || id).join('、')
  const alignmentLabels = installSelection.alignmentModels.map(id => alignmentModelCatalog.find(model => model.id === id)?.label || id).join('、')
  const withHarmony = installSelection.harmonyModels.length > 0
  return [
    { id: 'base-runtime', label: 'Python 与高速安装工具', detail: `内置 Python 3.12、uv 并行安装器 · ${packageSource.label}`, weight: 0.08 },
    { id: 'compute', label: computeProfile === 'cuda121' ? 'GPU 计算组件' : 'CPU 计算组件', detail: computeProfile === 'cuda121' ? 'PyTorch · CUDA 12.1' : 'PyTorch · CPU', weight: withHarmony ? 0.30 : 0.32 },
    { id: 'dependencies', label: '音频分析依赖', detail: `音高：${pitchLabels} · 按选择安装运行组件`, weight: withHarmony ? 0.25 : 0.28 },
    { id: 'separation-model', label: '人声分离模型', detail: separationLabels, weight: withHarmony ? 0.11 : 0.12 },
    ...(withHarmony ? [{ id: 'harmony-model', label: '提取主唱、剥离和声模型', detail: harmonyLabels, weight: 0.10 }] : []),
    { id: 'alignment-model', label: '歌词对齐模型', detail: alignmentLabels, weight: withHarmony ? 0.13 : 0.17 },
    { id: 'verify', label: '完整性检查', detail: '运行环境、模型与计算设备', weight: 0.03 },
  ]
}

function transferTelemetry(output) {
  const text = String(output || '')
  const speed = text.match(/([\d.]+)\s*([KMGT]?i?B)\/s/i)
  if (!speed) return {}
  const units = { KB: 1000, KIB: 1024, MB: 1000 ** 2, MIB: 1024 ** 2, GB: 1000 ** 3, GIB: 1024 ** 3, TB: 1000 ** 4, TIB: 1024 ** 4 }
  const speedBytesPerSecond = Number(speed[1]) * (units[speed[2].toUpperCase()] || 1)
  const eta = text.match(/<(\d+):(\d{2})(?::(\d{2}))?/)
  const etaSeconds = eta ? eta[3] ? Number(eta[1]) * 3600 + Number(eta[2]) * 60 + Number(eta[3]) : Number(eta[1]) * 60 + Number(eta[2]) : undefined
  return { speedBytesPerSecond, ...(etaSeconds === undefined ? {} : { etaSeconds }) }
}

function reportEnvironmentProgress(plan, componentId, componentProgress, message, detail = '', telemetry = {}) {
  const currentIndex = plan.findIndex(item => item.id === componentId)
  const bounded = Math.max(0, Math.min(1, Number(componentProgress) || 0))
  let overallProgress = 0
  const components = plan.map((item, index) => {
    if (index < currentIndex) {
      overallProgress += item.weight
      return { id: item.id, label: item.label, detail: item.detail, status: 'complete', progress: 1 }
    }
    if (index === currentIndex) {
      overallProgress += item.weight * bounded
      return { id: item.id, label: item.label, detail: item.detail, status: bounded >= 1 ? 'complete' : 'running', progress: bounded }
    }
    return { id: item.id, label: item.label, detail: item.detail, status: 'pending', progress: 0 }
  })
  const payload = { componentId, componentProgress: bounded, overallProgress: Math.min(1, overallProgress), components, detail, ...telemetry }
  sendAnalysisProgress('environment', message, payload)
  sendTaskProgress('environment', '准备完整分析环境', 'running', message, payload.overallProgress)
}

async function requireFreeSpace(bytes, label) {
  try { await mkdir(analysisRoot(), { recursive: true }) }
  catch { throw new Error(`无法写入环境目录 ${analysisRoot()}。请选择当前用户可写的位置后重试。`) }
  const stats = fs.statfsSync(analysisRoot())
  const available = Number(stats.bavail) * Number(stats.bsize)
  if (Number.isFinite(available) && available < bytes) {
    const neededGb = Math.ceil(bytes / 1024 / 1024 / 1024)
    const availableGb = Math.max(0, available / 1024 / 1024 / 1024).toFixed(1)
    throw new Error(`${label}至少需要约 ${neededGb} GB 可用空间，当前仅有 ${availableGb} GB。`)
  }
}

async function findBootstrapPython() {
  const candidates = [basePythonPath(), ...nearbyPythonPaths(), await savedPythonPath(), process.env.PITCHORD_PYTHON, process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean)
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

async function downloadVerifiedFile(url, destination, expectedHash, expectedSize, onProgress, label = '内置 Python', maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await downloadVerifiedFileAttempt(url, destination, expectedHash, expectedSize, onProgress, label) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === maxAttempts - 1 || !/ERR_|ECONN|ETIMEDOUT|fetch failed|network|连接|超时|abort|HTTP (?:429|5\d\d)/i.test(message)) throw error
      let partialSize = 0
      try { partialSize = (await fs.promises.stat(`${destination}.part`)).size } catch { /* retry from zero */ }
      onProgress?.(Math.min(1, partialSize / expectedSize), `${label}连接中断，正在从已下载位置重试（${attempt + 1}/${maxAttempts - 1}）…`, { downloadedBytes: partialSize, totalBytes: expectedSize, transferState: 'downloading' })
      await new Promise(resolve => setTimeout(resolve, Math.min(8000, 1000 * 2 ** attempt)))
    }
  }
}

async function fetchDownloadResponse(url, start, label) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await net.fetch(url, { signal: controller.signal, ...(start ? { headers: { Range: `bytes=${start}-` } } : {}) })
    return { response, controller }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label}连接超时（20 秒未收到响应）。`)
    throw error
  } finally { clearTimeout(timeout) }
}

async function downloadVerifiedFileAttempt(url, destination, expectedHash, expectedSize, onProgress, label) {
  const partial = `${destination}.part`
  let existingSize = 0
  try { existingSize = (await fs.promises.stat(partial)).size } catch { /* no resumable download */ }
  if (existingSize === expectedSize) {
    try {
      await verifyLocalFile(partial, expectedHash, expectedSize)
      await fs.promises.rename(partial, destination)
      onProgress?.(1, `已复用完整的${label}下载缓存。`, { downloadedBytes: expectedSize, totalBytes: expectedSize, transferState: 'cache' })
      return
    } catch {
      await fs.promises.rm(partial, { force: true })
      existingSize = 0
    }
  } else if (existingSize > expectedSize) {
    await fs.promises.rm(partial, { force: true })
    existingSize = 0
  }
  let { response, controller } = await fetchDownloadResponse(url, existingSize, label)
  if (!response.ok || !response.body) throw new Error(`${label}下载失败（HTTP ${response.status}）。`)
  if (existingSize && response.status !== 206) {
    await response.body.cancel()
    await fs.promises.rm(partial, { force: true })
    existingSize = 0
    ;({ response, controller } = await fetchDownloadResponse(url, 0, label))
    if (!response.ok || !response.body) throw new Error(`${label}下载失败（HTTP ${response.status}）。`)
  }
  const responseSize = Number(response.headers.get('content-length')) || 0
  const total = existingSize + responseSize || expectedSize
  const reader = response.body.getReader()
  const handle = await fs.promises.open(partial, existingSize ? 'a' : 'w')
  const hash = createHash('sha256')
  if (existingSize) for await (const chunk of fs.createReadStream(partial)) hash.update(chunk)
  let received = existingSize
  let lastPercent = -1
  let lastSampleAt = Date.now()
  let lastSampleBytes = received
  let speedBytesPerSecond = 0
  let idleTimeout
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeout)
    idleTimeout = setTimeout(() => controller.abort(), 30000)
  }
  try {
    try {
      resetIdleTimeout()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        resetIdleTimeout()
        const chunk = Buffer.from(value)
        received += chunk.length
        if (received > expectedSize + 1024) throw new Error(`${label}下载大小异常。`)
        hash.update(chunk)
        await handle.write(chunk)
        const percent = Math.min(100, Math.floor(received / total * 100))
        if (percent !== lastPercent) {
          lastPercent = percent
          const sampledAt = Date.now()
          const elapsedSeconds = (sampledAt - lastSampleAt) / 1000
          if (elapsedSeconds >= 0.25) {
            const instantSpeed = (received - lastSampleBytes) / elapsedSeconds
            speedBytesPerSecond = speedBytesPerSecond ? speedBytesPerSecond * 0.7 + instantSpeed * 0.3 : instantSpeed
            lastSampleAt = sampledAt
            lastSampleBytes = received
          }
          const message = `${existingSize ? '正在续传' : '正在下载'}${label}… ${percent}%`
          const telemetry = { downloadedBytes: received, totalBytes: expectedSize, transferState: 'downloading', ...(speedBytesPerSecond ? { speedBytesPerSecond, etaSeconds: Math.max(0, Math.round((expectedSize - received) / speedBytesPerSecond)) } : {}) }
          if (onProgress) onProgress(percent / 100, message, telemetry)
          else sendAnalysisProgress('base-runtime', message)
        }
      }
    } finally { clearTimeout(idleTimeout); await handle.close() }
  } catch (error) {
    if (received > expectedSize) await fs.promises.rm(partial, { force: true })
    if (controller.signal.aborted) throw new Error(`${label}等待下载数据超时（30 秒），已保留下载进度。`)
    throw error
  }
  if (received !== expectedSize) {
    if (received > expectedSize) await fs.promises.rm(partial, { force: true })
    throw new Error(`${label}下载不完整：应为 ${expectedSize} 字节，实际为 ${received} 字节。`)
  }
  const digest = hash.digest('hex')
  if (digest !== expectedHash) {
    await fs.promises.rm(partial, { force: true })
    throw new Error(`${label}校验失败，文件已丢弃。请检查网络后重试。`)
  }
  await fs.promises.rename(partial, destination)
}

async function verifyLocalFile(file, expectedHash, expectedSize, label = '离线基础运行时') {
  const stat = await fs.promises.stat(file)
  if (stat.size !== expectedSize) throw new Error(`${label}大小异常：应为 ${expectedSize} 字节，实际为 ${stat.size} 字节。`)
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== expectedHash) throw new Error(`${label}校验失败，请重新下载安装包。`)
}

async function ensureBaseRuntime(force = false, onProgress, preferDomestic = true) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前自动下载基础运行时仅支持 Windows 64 位。')
  if (!force && await probePython(basePythonPath())) {
    onProgress?.(1, '内置 Python 已存在，无需重复下载。')
    return basePythonPath()
  }
  const report = (progress, message, telemetry) => onProgress ? onProgress(progress, message, telemetry) : sendAnalysisProgress('base-runtime', message, telemetry)
  await requireFreeSpace(512 * 1024 * 1024, '安装内置 Python ')
  const downloads = path.join(analysisRoot(), 'downloads')
  const archive = path.join(downloads, baseRuntime.archive)
  const staging = `${baseRuntimeRoot()}.installing`
  await mkdir(downloads, { recursive: true })
  await fs.promises.rm(staging, { recursive: true, force: true })
  await fs.promises.rm(baseRuntimeRoot(), { recursive: true, force: true })
  const bundledArchive = path.join(offlineAnalysisRoot(), 'base-runtime', baseRuntime.archive)
  let selectedSource = { label: '安装包内置文件', url: baseRuntime.url }
  if (fs.existsSync(bundledArchive)) {
    report(0.15, '正在读取完整版内置 Python…')
    await verifyLocalFile(bundledArchive, baseRuntime.sha256, baseRuntime.size)
    await fs.promises.copyFile(bundledArchive, archive)
  } else {
    const official = { label: 'GitHub 官方线路', url: baseRuntime.url }
    const sources = orderedDownloadSources(official, baseRuntime.mirrors || [], preferDomestic)
    selectedSource = await downloadFromSources(sources, async source => {
      report(0.02, `正在通过${source.label}准备内置 Python…`, { transferState: 'downloading' })
      await downloadVerifiedFile(source.url, archive, baseRuntime.sha256, baseRuntime.size, (progress, message, telemetry) => report(progress * 0.75, `${source.label}：${message}`, telemetry))
    }, (source, reason, next) => report(0.02, `${source.label}未完成（${reason.slice(-120)}），正在切换至${next.label}…`, { transferState: 'downloading' }))
  }
  report(0.8, '下载校验通过，正在解压内置 Python…', { transferState: 'installing' })
  await mkdir(staging, { recursive: true })
  try {
    try { await runProcess('tar.exe', ['-xzf', archive, '-C', staging], { env: process.env }) }
    catch (error) { throw new Error(`无法解压内置 Python：${error instanceof Error ? error.message : String(error)}`) }
    const extractedPython = path.join(staging, 'python', pythonExecutable)
    const probe = await probePython(extractedPython)
    if (!probe) throw new Error('内置 Python 解压完成，但启动检查失败。')
    await fs.promises.rename(staging, baseRuntimeRoot())
    await writeFile(path.join(baseRuntimeRoot(), 'pitchord-base-runtime.json'), JSON.stringify({
      version: baseRuntime.version,
      source: selectedSource.url,
      sha256: baseRuntime.sha256,
      sourceProject: 'astral-sh/python-build-standalone',
      sourceLicense: 'MPL-2.0; bundled CPython and components retain their respective licenses',
      installedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true })
    throw error
  } finally { await fs.promises.rm(archive, { force: true }) }
  report(1, '内置 Python 已准备完成。')
  return basePythonPath()
}

async function prepareDemucsCheckpoints(model, onProgress, taskId) {
  const checkpoints = demucsCheckpoints[model.id]
  if (!Array.isArray(checkpoints) || !checkpoints.length) return null
  const directory = demucsCheckpointDirectory()
  await mkdir(directory, { recursive: true })
  const official = file => ({ label: 'Demucs 官方线路', url: `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/${file}` })
  const domestic = file => ({ label: '国内模型加速线路（HF Mirror）', url: `https://hf-mirror.com/${demucsCheckpoints.repository}/resolve/${demucsCheckpoints.revision}/${file}` })
  const usedSources = new Set()
  for (const [index, checkpoint] of checkpoints.entries()) {
    if (pendingTaskCancellations.delete(taskId)) throw new TaskCancelledError()
    const destination = path.join(directory, checkpoint.file)
    if (fs.existsSync(destination)) {
      try {
        await verifyLocalFile(destination, checkpoint.sha256, checkpoint.size, checkpoint.file)
        onProgress?.(0.06 + 0.84 * (index + 1) / checkpoints.length, `${model.label}：已复用并校验 ${checkpoint.file}（${index + 1}/${checkpoints.length}）。`, '', { transferState: 'cache' })
        continue
      } catch {
        await fs.promises.rm(destination, { force: true })
      }
    }
    const sources = process.env.PITCHORD_MODEL_SOURCE === 'official'
      ? [official(checkpoint.file), domestic(checkpoint.file)]
      : [domestic(checkpoint.file), official(checkpoint.file)]
    const selected = await downloadFromSources(sources, async source => {
      onProgress?.(0.06 + 0.84 * index / checkpoints.length, `${model.label}：正在通过${source.label}下载权重 ${index + 1}/${checkpoints.length}…`, checkpoint.file, { transferState: 'downloading' })
      await downloadVerifiedFile(source.url, destination, checkpoint.sha256, checkpoint.size, (progress, message, telemetry) => {
        if (pendingTaskCancellations.delete(taskId)) throw new TaskCancelledError()
        onProgress?.(0.06 + 0.84 * (index + progress) / checkpoints.length, `${model.label}：${source.label} · ${message}`, checkpoint.file, telemetry)
      }, checkpoint.file, 2)
    }, (source, reason, next) => onProgress?.(0.06 + 0.84 * index / checkpoints.length, `${model.label}：${source.label}未完成，正在切换${next.label}…`, reason.slice(-180), { transferState: 'downloading' }))
    usedSources.add(selected.label)
  }
  return [...usedSources].join('、') || '已缓存'
}

async function ensureRecommendedSeparationModel(python, modelId, onProgress, taskId = 'environment', taskTitle = '准备完整分析环境') {
  const selectedModel = separationModel(modelId)
  try {
    const marker = JSON.parse(await readFile(modelMarker(selectedModel.id), 'utf8'))
    if (marker.model === selectedModel.id && demucsCheckpointsPresent(selectedModel.id)) {
      onProgress?.(1, `${selectedModel.label} 已存在，无需重复下载。`)
      return
    }
  } catch { /* model is not ready */ }
  await mkdir(path.dirname(modelMarker(selectedModel.id)), { recursive: true })
  const bundledModels = path.join(offlineAnalysisRoot(), 'models')
  const beforeFiles = new Set(await listFilesRecursive(modelRoot()))
  let source = 'download'
  if (selectedModel.bundled && fs.existsSync(bundledModels)) {
    onProgress?.(0.15, `正在从完整版安装 ${selectedModel.label}…`)
    await fs.promises.cp(bundledModels, modelRoot(), { recursive: true, force: true })
    source = 'offline-bundle'
  } else {
    let ticks = 0
    const preloadedSource = await prepareDemucsCheckpoints(selectedModel, onProgress, taskId)
    source = preloadedSource || 'Demucs 官方线路'
    onProgress?.(preloadedSource ? 0.92 : 0.04, preloadedSource
      ? `正在验证 ${selectedModel.label} 人声分离模型…`
      : `正在通过Demucs 官方线路下载 ${selectedModel.label} 人声分离模型…`, source, { transferState: preloadedSource ? 'installing' : 'downloading' })
    const program = `from demucs.pretrained import get_model; get_model(${JSON.stringify(selectedModel.id)}); print('ready')`
    const downloadEnvironment = analysisEnvironment(python)
    delete downloadEnvironment.HF_HUB_OFFLINE
    await runProcess(python, ['-c', program], {
      env: downloadEnvironment,
      taskId,
      taskTitle,
      onOutput: output => {
        const line = output.trim().split(/\r?\n/).at(-1)
        if (!line || /unauthenticated requests|HF_TOKEN/i.test(line)) return
        ticks += 1
        onProgress?.(preloadedSource ? Math.min(0.98, 0.92 + ticks * 0.01) : Math.min(0.92, 0.08 + ticks * 0.025), preloadedSource
          ? `${selectedModel.label}：正在加载并验证模型…`
          : `${selectedModel.label}：Demucs 官方线路 · 正在下载模型…`, line.slice(0, 240), { transferState: preloadedSource ? 'installing' : 'downloading', ...transferTelemetry(line) })
      },
    })
  }
  const files = [...new Set([
    ...(await listFilesRecursive(modelRoot())).filter(file => !beforeFiles.has(file) && file !== path.relative(modelRoot(), modelMarker(selectedModel.id))),
    ...(demucsCheckpoints[selectedModel.id] || []).map(checkpoint => path.relative(modelRoot(), path.join(demucsCheckpointDirectory(), checkpoint.file))),
  ])]
  await writeFile(modelMarker(selectedModel.id), JSON.stringify({ model: selectedModel.id, preparedAt: new Date().toISOString(), source, files }, null, 2), 'utf8')
  onProgress?.(1, `${selectedModel.label} 人声分离模型已准备完成。`)
}

async function ensureRecommendedAlignmentModel(python, modelId, onProgress, taskId = 'environment', taskTitle = '准备完整分析环境') {
  const selectedModel = alignmentModelCatalog.find(model => model.id === modelId)
  const output = alignmentModelDirectory(modelId)
  if (fs.existsSync(alignmentModelMarker(modelId)) && fs.existsSync(path.join(output, 'model.bin'))) {
    onProgress?.(1, `${selectedModel.label} 已存在，无需重复下载。`)
    return
  }
  await mkdir(output, { recursive: true })
  onProgress?.(0.02, `正在为 ${selectedModel.label} 测速选择模型下载线路…`)
  const preferredSource = await chooseModelSource(selectedModel)
  const sources = preferredSource.id === 'domestic' ? [domesticModelSource, officialModelSource] : [officialModelSource, domesticModelSource]
  let lastError
  for (const [sourceIndex, source] of sources.entries()) {
    const environment = analysisEnvironment(python)
    delete environment.HF_HUB_OFFLINE
    environment.HF_ENDPOINT = source.endpoint
    if (source.id === 'domestic') environment.HF_HUB_DISABLE_XET = '1'
    let latestProgress = 0.05
    onProgress?.(latestProgress, `已选择${source.label}，正在下载 ${selectedModel.label}…`, '', { transferState: 'downloading' })
    try {
      await runProcess(python, [path.join(scriptRoot, 'prepare-aligner.py'), '--model', modelId, '--revision', selectedModel.revision, '--output', output], {
        env: environment,
        taskId,
        taskTitle,
        transferPaths: [path.join(modelRoot(), 'huggingface'), output],
        onTransfer: telemetry => onProgress?.(latestProgress, `正在通过${source.label}下载 ${selectedModel.label}…`, '', telemetry),
        onOutput: outputText => {
          for (const line of outputText.split(/\r?\n/)) {
            if (!line || /unauthenticated requests|HF_TOKEN/i.test(line)) continue
            const progress = line.match(/^PITCHORD_PROGRESS\|([\d.]+)\|(.*)$/)
            latestProgress = progress ? Number(progress[1]) : Math.max(latestProgress, 0.08)
            onProgress?.(latestProgress, progress?.[2] || `正在通过${source.label}下载 ${selectedModel.label}…`, progress ? '' : line.slice(-240), { transferState: progress && latestProgress >= 1 ? 'installing' : 'downloading', ...transferTelemetry(line) })
          }
        },
      })
      lastError = null
      break
    } catch (error) {
      if (isTaskCancelled(error)) throw error
      lastError = error
      if (sourceIndex < sources.length - 1) onProgress?.(Math.max(latestProgress, 0.08), `${source.label}未完成，正在保留进度并切换备用线路…`, error instanceof Error ? error.message.slice(-240) : String(error).slice(-240), { transferState: 'downloading' })
    }
  }
  if (lastError) throw lastError
  if (!fs.existsSync(path.join(output, 'model.bin'))) throw new Error('下载结束，但没有找到完整的歌词对齐模型文件。')
  await writeFile(alignmentModelMarker(modelId), JSON.stringify({ model: modelId, provider: 'faster-whisper', revision: selectedModel.revision, preparedAt: new Date().toISOString() }, null, 2), 'utf8')
  onProgress?.(1, `${selectedModel.label} 歌词对齐模型已准备完成。`)
}

async function ensureRecommendedHarmonyModel(modelId, onProgress) {
  const model = harmonyModelCatalog.find(item => item.id === modelId)
  if (!model) throw new Error('不支持的去和声模型。')
  if (!fs.existsSync(path.join(msstRoot, 'inference.py'))) throw new Error('当前安装包缺少去和声推理组件。')
  await requireFreeSpace(512 * 1024 * 1024, '准备去和声模型')
  const directory = path.join(modelRoot(), 'harmony', model.id)
  await mkdir(directory, { recursive: true })
  const files = [
    { name: model.configName, hash: model.configSha256, size: model.configSize, label: '模型配置' },
    { name: model.checkpointName, hash: model.checkpointSha256, size: model.checkpointSize, label: '去和声权重' },
  ]
  onProgress?.(0.01, `正在准备 ${model.label}…`)
  for (const [index, file] of files.entries()) {
    const destination = path.join(directory, file.name)
    try { await verifyLocalFile(destination, file.hash, file.size) }
    catch {
      await fs.promises.rm(destination, { force: true })
      const sourcePath = `${model.repository}/resolve/${model.revision}/${file.name}`
      await downloadFromSources([
        { label: 'HF Mirror 国内线路', url: `https://hf-mirror.com/${sourcePath}` },
        { label: 'Hugging Face 官方线路', url: `https://huggingface.co/${sourcePath}` },
      ], async source => {
        onProgress?.(index / files.length, `正在通过${source.label}下载${file.label}…`, '', { transferState: 'downloading' })
        await downloadVerifiedFile(source.url, destination, file.hash, file.size, (progress, message, telemetry) => {
          onProgress?.((index + progress) / files.length, `${source.label}：${message}`, '', telemetry)
        }, file.label)
      }, (source, reason, next) => onProgress?.(index / files.length, `${source.label}未完成，正在切换至${next.label}…`, reason.slice(-240), { transferState: 'downloading' }))
    }
    onProgress?.((index + 1) / files.length, `${file.label}已校验。`)
  }
  await writeFile(path.join(directory, 'pitchord-model.json'), JSON.stringify({ model: model.id, source: `https://huggingface.co/${model.repository}`, revision: model.revision, preparedAt: new Date().toISOString() }, null, 2), 'utf8')
  onProgress?.(1, `${model.label} 已准备完成。`)
}

async function ensureRmvpeModel(onProgress) {
  const destination = rmvpeModelPath()
  await mkdir(path.dirname(destination), { recursive: true })
  try { await verifyLocalFile(destination, rmvpeModel.sha256, rmvpeModel.size) }
  catch {
    await requireFreeSpace(512 * 1024 * 1024, '准备 RMVPE 音高模型')
    await fs.promises.rm(destination, { force: true })
    const sourcePath = `${rmvpeModel.repository}/resolve/${rmvpeModel.revision}/${rmvpeModel.filename}`
    await downloadFromSources([
      { label: 'HF Mirror 国内线路', url: `https://hf-mirror.com/${sourcePath}` },
      { label: 'Hugging Face 官方线路', url: `https://huggingface.co/${sourcePath}` },
    ], async source => {
      onProgress?.(0.01, `正在通过${source.label}下载 RMVPE 权重…`, '', { transferState: 'downloading' })
      await downloadVerifiedFile(source.url, destination, rmvpeModel.sha256, rmvpeModel.size,
        (progress, message, telemetry) => onProgress?.(progress, `${source.label}：${message}`, '', telemetry), 'RMVPE 权重')
    }, (source, reason, next) => onProgress?.(0.01, `${source.label}未完成，正在切换至${next.label}…`, reason.slice(-240), { transferState: 'downloading' }))
  }
  await writeFile(rmvpeModelMarker(), JSON.stringify({ model: 'rmvpe', source: `https://huggingface.co/${rmvpeModel.repository}`,
    revision: rmvpeModel.revision, sha256: rmvpeModel.sha256, preparedAt: new Date().toISOString() }, null, 2), 'utf8')
  onProgress?.(1, 'RMVPE 权重已校验，可以开始识别音高。')
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

app.whenReady().then(async () => {
  await loadAnalysisRoot()
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
      filters: name.endsWith('.lrc') ? [{ name: 'LRC 歌词', extensions: ['lrc'] }] : name.endsWith('.ass') ? [{ name: 'ASS 字幕', extensions: ['ass'] }] : name.endsWith('.json') ? [{ name: 'JSON 数据', extensions: ['json'] }] : [{ name: '文本文件', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, content, 'utf8')
    return true
  })

  ipcMain.handle('pitchord:get-python', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    return preferredPythonPath()
  })

  ipcMain.handle('pitchord:choose-analysis-directory', async (event, currentPath) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Pitchord 环境存放位置',
      defaultPath: typeof currentPath === 'string' && path.isAbsolute(currentPath) ? currentPath : analysisRoot(),
      properties: ['openDirectory', 'createDirectory'],
    })
    return picked.canceled ? null : picked.filePaths[0]
  })

  ipcMain.handle('pitchord:choose-existing-analysis-directory', async (event, currentPath) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择已有的 Pitchord environment 文件夹',
      defaultPath: typeof currentPath === 'string' && path.isAbsolute(currentPath) ? currentPath : applicationDirectory(),
      properties: ['openDirectory'],
    })
    return picked.canceled ? null : picked.filePaths[0]
  })

  ipcMain.handle('pitchord:choose-python', async (event, currentPath) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择现有 Python 环境',
      defaultPath: typeof currentPath === 'string' && currentPath ? path.dirname(currentPath) : applicationDirectory(),
      properties: ['openFile'],
      filters: [{ name: 'Python', extensions: process.platform === 'win32' ? ['exe'] : [''] }],
    })
    return picked.canceled ? null : picked.filePaths[0]
  })

  ipcMain.handle('pitchord:configure-analysis-environment', async (event, request) => {
    if (event.sender !== mainWindow?.webContents || !request || !['managed', 'custom', 'existing'].includes(request.mode)) throw new Error('Invalid environment configuration')
    if (analysisInstallTask || activeAnalysisTasks.size) throw new Error('分析任务正在运行，请在任务结束或取消后切换环境。')
    if (request.mode === 'managed') {
      if (typeof request.root !== 'string' || !path.isAbsolute(request.root)) throw new Error('请选择有效的环境目录。')
      configuredAnalysisRoot = path.resolve(request.root)
      await mkdir(configuredAnalysisRoot, { recursive: true })
      const computeProfile = ['auto', 'cpu', 'cuda121'].includes(request.computeProfile) ? request.computeProfile : 'auto'
      await writeSettings({ analysisRoot: configuredAnalysisRoot, runtimePreference: 'managed', computeProfile })
    } else if (request.mode === 'existing') {
      const found = findExistingEnvironment(request.root, pythonExecutable, baseRuntime.version)
      const probe = await probePython(found.pythonPath)
      if (!probe) throw new Error('所选 environment 中的 Python 无法启动。请确认文件夹没有缺失或损坏。')
      const majorMinor = probe.version.split('.').slice(0, 2).map(Number)
      if (majorMinor[0] !== 3 || majorMinor[1] < 10 || majorMinor[1] > 12) throw new Error(`当前支持 Python 3.10–3.12，所选版本为 ${probe.version}。`)
      await writeSettings({ analysisRoot: found.root, pythonPath: found.pythonPath, runtimePreference: 'existing' })
      configuredAnalysisRoot = found.root
    } else {
      if (typeof request.pythonPath !== 'string' || !path.isAbsolute(request.pythonPath) || !fs.existsSync(request.pythonPath)) throw new Error('请选择有效的 Python 可执行文件。')
      const probe = await probePython(request.pythonPath)
      if (!probe) throw new Error('所选 Python 无法启动，或不是可用的 Python 3 环境。')
      const majorMinor = probe.version.split('.').slice(0, 2).map(Number)
      if (majorMinor[0] !== 3 || majorMinor[1] < 10 || majorMinor[1] > 12) throw new Error(`当前支持 Python 3.10–3.12，所选版本为 ${probe.version}。`)
      const inferred = inferExistingEnvironmentFromPython(request.pythonPath, pythonExecutable, baseRuntime.version)
      if (inferred) {
        await writeSettings({ analysisRoot: inferred.root, pythonPath: inferred.pythonPath, runtimePreference: 'existing' })
        configuredAnalysisRoot = inferred.root
      } else await rememberPythonPath(path.resolve(request.pythonPath))
    }
    return analysisRuntimeStatus()
  })

  ipcMain.handle('pitchord:analysis-status', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    return analysisRuntimeStatus()
  })

  ipcMain.handle('pitchord:cancel-analysis-task', async (event, taskId) => {
    if (event.sender !== mainWindow?.webContents || !cancellableAnalysisTasks.has(taskId)) throw new Error('Invalid analysis task')
    const task = activeAnalysisTasks.get(taskId)
    if (!task) {
      pendingTaskCancellations.add(taskId)
      sendTaskProgress(taskId, taskId === 'environment' ? '准备分析环境' : taskId === 'separation' ? '人声分离' : taskId === 'pitch' ? '连续音高识别' : '歌词时间戳匹配', 'running', '已收到取消请求，正在停止启动过程…')
      return true
    }
    task.cancelled = true
    sendTaskProgress(taskId, task.title, 'running', '正在停止模型并清理运行进程…')
    await stopProcessTree(task.child)
    return true
  })

  ipcMain.handle('pitchord:analysis-storage-status', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    return analysisStorageStatus()
  })

  ipcMain.handle('pitchord:remove-analysis-data', async (event, target) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (analysisInstallTask) throw new Error('分析环境正在执行另一项操作，请完成后再清理。')
    return removeManagedAnalysisData(target)
  })

  ipcMain.handle('pitchord:prepare-base-runtime', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (analysisInstallTask) throw new Error('分析环境正在执行另一项操作，请稍候。')
    analysisInstallTask = (async () => {
      await ensureBaseRuntime()
      return { ...await analysisRuntimeStatus(), busy: false }
    })()
    try { return await analysisInstallTask } finally { analysisInstallTask = null }
  })

  ipcMain.handle('pitchord:install-analysis-runtime', async (event, request = {}) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (analysisInstallTask) throw new Error('分析环境正在执行另一项操作，请稍候。')
    analysisInstallTask = (async () => {
      if (typeof request.root === 'string' && path.isAbsolute(request.root)) configuredAnalysisRoot = path.resolve(request.root)
      const requestedProfile = ['auto', 'cpu', 'cuda121'].includes(request.computeProfile) ? request.computeProfile : await configuredComputeProfile()
      const installSelection = normalizeInstallSelection(request.installSelection, true)
      await writeSettings({ analysisRoot: analysisRoot(), runtimePreference: 'managed', computeProfile: requestedProfile })
      const detectedGpu = await detectNvidiaGpu()
      let resolvedProfile = requestedProfile === 'auto' ? detectedGpu ? 'cuda121' : 'cpu' : requestedProfile
      sendTaskProgress('environment', '准备完整分析环境', 'running', '正在自动选择最快的软件下载线路…', 0.005)
      let packageSource = await choosePackageSource(resolvedProfile)
      let plan = environmentPlan(resolvedProfile, packageSource, installSelection)
      const reportedComponentProgress = new Map()
      const report = (componentId, progress, message, detail = '', telemetry = {}) => {
        const monotonicProgress = Math.max(reportedComponentProgress.get(componentId) || 0, progress)
        reportedComponentProgress.set(componentId, monotonicProgress)
        reportEnvironmentProgress(plan, componentId, monotonicProgress, message, detail, telemetry)
      }
      const requiredBytes = fs.existsSync(managedPythonPath())
        ? resolvedProfile === 'cuda121' ? 5 * 1024 * 1024 * 1024 : 3 * 1024 * 1024 * 1024
        : resolvedProfile === 'cuda121' ? 8 * 1024 * 1024 * 1024 : 5 * 1024 * 1024 * 1024
      await requireFreeSpace(requiredBytes, '安装分析环境')
      report('base-runtime', 0.01, `已选择${packageSource.label}，将一次准备 ${plan.length} 项完整能力。`)
      let python
      if (process.platform === 'win32' && process.arch === 'x64') python = await ensureBaseRuntime(false, (progress, message, telemetry) => report('base-runtime', progress * 0.8, message, '', telemetry), packageSource.id === 'domestic')
      else python = (await findBootstrapPython())?.executable
      if (!python) throw new Error('未找到可用于安装分析依赖的 Python 3。')
      const wheelhouse = path.join(offlineAnalysisRoot(), 'wheelhouse')
      const offlineRequirements = path.join(offlineAnalysisRoot(), 'analysis-lock-win-x64.txt')
      const useOfflineBundle = resolvedProfile === 'cpu' && !installSelection.pitchMethods.some(id => id === 'rmvpe' || id === 'fcpe') && fs.existsSync(wheelhouse) && fs.existsSync(offlineRequirements)
      let currentComponent = 'base-runtime'
      let componentMessage = '正在准备完整分析环境…'
      let progressTicks = 0
      let componentStart = 0.02
      const beginComponent = (id, message, start = 0.02) => {
        currentComponent = id
        componentMessage = message
        progressTicks = 0
        componentStart = start
        report(id, start, message, '', { transferState: 'installing' })
      }
      const finishComponent = message => report(currentComponent, 1, message || componentMessage, '', { transferState: 'installing' })
      const progressOutput = output => {
        const line = output.trim().split(/\r?\n/).at(-1)
        if (line) {
          progressTicks += 1
          const telemetry = transferTelemetry(line)
          report(currentComponent, Math.min(0.92, componentStart + progressTicks * 0.012), componentMessage, line.slice(0, 240), { transferState: Object.keys(telemetry).length || /download|fetch/i.test(line) ? 'downloading' : 'installing', ...telemetry })
        }
      }
      const processOptions = () => ({
        env: analysisEnvironment(python),
        taskId: 'environment',
        taskTitle: '准备完整分析环境',
        onOutput: progressOutput,
        transferPaths: [path.join(analysisRoot(), 'cache', 'uv'), path.join(analysisRoot(), 'cache', 'pip')],
        onTransfer: telemetry => report(currentComponent, reportedComponentProgress.get(currentComponent) || componentStart, componentMessage, '', telemetry),
      })
      const sourceArguments = source => ['--index-url', source.pypi]
      const activatePackageSource = source => {
        packageSource = source
        plan = environmentPlan(resolvedProfile, packageSource, installSelection)
      }
      let uvAvailable = false
      if (!useOfflineBundle) {
        beginComponent('base-runtime', '正在准备高速并行安装器…', 0.82)
        try {
          const uvProbe = await runProcess(python, ['-c', "import importlib.util; print('ready' if importlib.util.find_spec('uv') else 'missing')"], { env: analysisEnvironment(python) })
          uvAvailable = uvProbe.stdout.trim().endsWith('ready')
          const bundledUvWheel = path.join(app.isPackaged ? process.resourcesPath : appRoot, 'vendor', 'uv', bootstrapInstaller.wheel)
          if (!uvAvailable && process.platform === 'win32' && process.arch === 'x64' && fs.existsSync(bundledUvWheel)) {
            try {
              report('base-runtime', 0.86, '正在从安装包准备高速安装工具，无需联网下载…', '', { transferState: 'installing' })
              await verifyLocalFile(bundledUvWheel, bootstrapInstaller.sha256, bootstrapInstaller.size, '内置高速安装工具')
              await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--no-deps', bundledUvWheel], processOptions())
              uvAvailable = true
            } catch (error) {
              if (isTaskCancelled(error)) throw error
              report('base-runtime', 0.9, '安装包内的高速工具不可用，正在尝试在线备用线路…', error instanceof Error ? error.message.slice(-240) : String(error).slice(-240))
            }
          }
          if (!uvAvailable) {
            const bootstrapSources = packageSource.id === 'domestic' ? [packageSource, officialPackageSource] : [packageSource]
            let lastBootstrapError
            for (const source of bootstrapSources) {
              try {
                report('base-runtime', 0.9, `正在从${source.label}准备高速安装工具…`)
                await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--retries', '1', '--timeout', '20', '--only-binary', ':all:', '--no-deps', '--index-url', source.pypi, `uv==${bootstrapInstaller.version}`], processOptions())
                activatePackageSource(source)
                uvAvailable = true
                break
              } catch (error) {
                if (isTaskCancelled(error)) throw error
                lastBootstrapError = error
              }
            }
            if (!uvAvailable) throw lastBootstrapError
          }
        } catch (error) {
          if (isTaskCancelled(error)) throw error
          report('base-runtime', 0.96, '高速安装器不可用，将自动使用兼容安装模式。', error instanceof Error ? error.message.slice(-240) : String(error).slice(-240))
        }
        finishComponent(uvAvailable ? 'Python 与高速并行安装器已准备完成。' : 'Python 与兼容安装工具已准备完成。')
        const installPackages = async argumentsForSource => {
          const candidateSources = packageSource.id === 'domestic' ? [packageSource, officialPackageSource] : [packageSource]
          let lastError
          if (uvAvailable) {
            for (const source of candidateSources) {
              try {
                await runProcess(python, ['-m', 'uv', 'pip', 'install', '--python', python, '--cache-dir', path.join(analysisRoot(), 'cache', 'uv'), ...argumentsForSource(source, 'uv')], processOptions())
                if (source.id !== packageSource.id) activatePackageSource(source)
                return
              } catch (error) {
                if (isTaskCancelled(error)) throw error
                lastError = error
                if (source.id === 'domestic') report(currentComponent, 0.92, `${componentMessage}（国内线路未完成，正在自动尝试官方线路）`, error instanceof Error ? error.message.slice(-240) : String(error).slice(-240))
              }
            }
            uvAvailable = false
            report(currentComponent, 0.92, `${componentMessage}（并行安装模式未完成，正在用兼容模式继续）`, lastError instanceof Error ? lastError.message.slice(-240) : String(lastError).slice(-240))
          }
          for (const source of candidateSources) {
            try {
              await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--retries', '8', '--resume-retries', '8', '--timeout', '120', ...argumentsForSource(source, 'pip')], processOptions())
              if (source.id !== packageSource.id) activatePackageSource(source)
              return
            } catch (error) {
              if (isTaskCancelled(error)) throw error
              lastError = error
              if (source.id === 'domestic') report(currentComponent, 0.92, `${componentMessage}（国内线路未完成，正在自动尝试官方线路）`, error instanceof Error ? error.message.slice(-240) : String(error).slice(-240))
            }
          }
          throw lastError
        }
        beginComponent('compute', resolvedProfile === 'cuda121' ? '正在并行安装 GPU 计算组件（PyTorch · CUDA 12.1）…' : '正在并行安装 CPU 计算组件（PyTorch）…')
        const torchArguments = profile => source => ['--index-url', torchIndex(source, profile), `torch==2.5.1+${profile === 'cuda121' ? 'cu121' : 'cpu'}`, `torchaudio==2.5.1+${profile === 'cuda121' ? 'cu121' : 'cpu'}`]
        await installPackages(torchArguments(resolvedProfile))
        if (requestedProfile === 'auto' && resolvedProfile === 'cuda121' && !(await probePython(python))?.cudaAvailable) {
          resolvedProfile = 'cpu'
          plan = environmentPlan(resolvedProfile, packageSource, installSelection)
          beginComponent('compute', 'GPU 运行检查未通过，正在自动切换到 CPU 计算组件…', 0.5)
          await installPackages((source, installer) => [installer === 'uv' ? '--reinstall' : '--force-reinstall', ...torchArguments('cpu')(source)])
        }
        finishComponent(`${resolvedProfile === 'cuda121' ? 'GPU' : 'CPU'} 计算组件已安装。`)
        beginComponent('dependencies', '正在并行安装所选音频分析组件…')
        const selectedRequirements = [
          'demucs==4.1.0',
          ...pitchInstallRequirements(installSelection.pitchMethods),
          'faster-whisper==1.2.1',
          'omegaconf==2.2.3',
          'ml-collections==1.1.0',
          'beartype==0.14.1',
          'rotary-embedding-torch==0.3.5',
        ]
        const constraints = path.join(scriptRoot, 'analysis-lock-win-x64.txt')
        await installPackages(source => [...sourceArguments(source), ...selectedRequirements, '--constraint', constraints])
      } else {
        report('base-runtime', 1, 'Python 与安装工具已准备完成。')
        report('compute', 1, '离线 CPU 计算组件已准备完成。')
        beginComponent('dependencies', '正在从本地完整版安装音频分析依赖…')
        await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--find-links', wheelhouse, '--requirement', offlineRequirements], processOptions())
      }
      const probe = await probePython(python)
      const selectedPackagesReady = !!probe?.demucs && !!probe?.fasterWhisper && selectedPitchMethodsReady(probe, installSelection.pitchMethods)
      if (!selectedPackagesReady) throw new Error('依赖安装完成，但所选分析组件未通过完整性检查。请再次点击修复。')
      if (resolvedProfile === 'cuda121' && !probe.cudaAvailable) throw new Error('CUDA 组件已安装，但 PyTorch 无法使用当前显卡。请选择“自动选择”或 CPU 环境后重试。')
      if (installSelection.pitchMethods.includes('rmvpe')) {
        beginComponent('dependencies', '正在准备 RMVPE 音高模型权重…', 0.75)
        await ensureRmvpeModel((progress, message, detail, telemetry) => report('dependencies', 0.75 + progress * 0.25, message, detail, telemetry))
      }
      finishComponent('音频分析依赖与所选音高模型已准备完成。')
      const environmentManifest = { schemaVersion: 1, managedBy: 'Pitchord', runtimeVersion: analysisRuntimeVersion, requestedProfile, resolvedProfile, python, pythonVersion: probe.version, installSelection, createdAt: new Date().toISOString() }
      await writeFile(path.join(managedRuntimeRoot(), 'pitchord-runtime.json'), JSON.stringify(environmentManifest, null, 2), 'utf8')
      await writeFile(path.join(analysisRoot(), 'pitchord-environment.json'), JSON.stringify(environmentManifest, null, 2), 'utf8')
      await preferManagedRuntime(requestedProfile)
      for (const [index, modelId] of installSelection.separationModels.entries()) {
        await ensureRecommendedSeparationModel(python, modelId, (progress, message, detail, telemetry) => report('separation-model', (index + progress) / installSelection.separationModels.length, message, detail, telemetry))
      }
      for (const [index, modelId] of installSelection.harmonyModels.entries()) {
        await ensureRecommendedHarmonyModel(modelId, (progress, message, detail, telemetry) => report('harmony-model', (index + progress) / installSelection.harmonyModels.length, message, detail, telemetry))
      }
      for (const [index, modelId] of installSelection.alignmentModels.entries()) {
        await ensureRecommendedAlignmentModel(python, modelId, (progress, message, detail, telemetry) => report('alignment-model', (index + progress) / installSelection.alignmentModels.length, message, detail, telemetry))
      }
      report('verify', 0.25, '正在检查全部组件与推荐模型…')
      const finalStatus = await analysisRuntimeStatus()
      const selectedModelsReady = installSelection.separationModels.every(id => finalStatus.separationModels.find(model => model.id === id)?.ready) && installSelection.harmonyModels.every(id => finalStatus.harmonyModels.find(model => model.id === id)?.ready) && installSelection.alignmentModels.every(id => finalStatus.alignment.models.find(model => model.id === id)?.ready)
      if (!finalStatus.completeReady || !selectedModelsReady) throw new Error('完整环境安装结束，但部分所选模型未通过检查。请点击修复后重试。')
      report('verify', 1, '完整分析环境已准备完成。')
      sendAnalysisProgress('complete', '完整分析环境已准备完成。', { overallProgress: 1, componentProgress: 1, components: plan.map(item => ({ id: item.id, label: item.label, detail: item.detail, status: 'complete', progress: 1 })) })
      sendTaskProgress('environment', '准备完整分析环境', 'success', `${resolvedProfile === 'cuda121' ? 'GPU' : 'CPU'} 环境与所选模型已全部准备完成`, 1)
      return { ...finalStatus, busy: false }
    })()
    try { return await analysisInstallTask }
    catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = isTaskCancelled(error) ? '环境准备已取消' : rawMessage
      sendTaskProgress('environment', '准备完整分析环境', isTaskCancelled(error) ? 'cancelled' : 'error', message)
      throw error
    } finally { analysisInstallTask = null }
  })

  ipcMain.handle('pitchord:prepare-analysis-model', async (event, requestedModel = analysisModel) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (analysisInstallTask) throw new Error('分析环境正在执行另一项操作，请稍候。')
    const selectedModel = separationModel(requestedModel)
    if (selectedModel.source === 'custom') return { ...await analysisRuntimeStatus(), busy: false }
    analysisInstallTask = (async () => {
      await requireFreeSpace(1024 * 1024 * 1024, '准备人声分离模型')
      const python = await preferredPythonPath()
      const probe = await probePython(python)
      if (!probe?.demucs) throw new Error('请先安装或修复分析环境。')
      await ensureRecommendedSeparationModel(python, selectedModel.id, (progress, message, detail, telemetry) => {
        sendAnalysisProgress('model', message, { overallProgress: progress, detail, ...telemetry })
        sendTaskProgress('environment-model', '准备人声分离模型', 'running', message, progress)
      }, 'environment-model', '准备人声分离模型')
      sendAnalysisProgress('complete', '人声分离模型已准备完成。')
      sendTaskProgress('environment-model', '准备人声分离模型', 'success', `${selectedModel.label} 已准备完成`, 1)
      return { ...await analysisRuntimeStatus(), busy: false }
    })()
    try { return await analysisInstallTask }
    catch (error) {
      const message = readableModelError(error)
      sendTaskProgress('environment-model', '准备人声分离模型', 'error', message)
      throw new Error(message)
    } finally { analysisInstallTask = null }
  })

  ipcMain.handle('pitchord:prepare-harmony-model', async (event, modelId = harmonyModelCatalog[0].id) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (analysisInstallTask) throw new Error('分析环境正在执行另一项操作，请稍候。')
    const model = harmonyModelCatalog.find(item => item.id === modelId)
    if (!model) throw new Error('不支持的去和声模型。')
    analysisInstallTask = (async () => {
      const python = await preferredPythonPath()
      const probe = await probePython(python)
      if (!python || !probe?.demucs || !fs.existsSync(path.join(msstRoot, 'inference.py'))) throw new Error('请先安装或修复分析环境。')
      sendTaskProgress('environment-model', '准备去和声模型', 'running', `正在准备 ${model.label}…`, 0.01)
      await ensureRecommendedHarmonyModel(modelId, (progress, message, _detail, telemetry) => {
        sendAnalysisProgress('model', message, telemetry)
        sendTaskProgress('environment-model', '准备去和声模型', 'running', message, progress)
      })
      sendTaskProgress('environment-model', '准备去和声模型', 'success', `${model.label} 已准备完成`, 1)
      return { ...await analysisRuntimeStatus(), busy: false }
    })()
    try { return await analysisInstallTask }
    catch (error) {
      sendTaskProgress('environment-model', '准备去和声模型', 'error', error instanceof Error ? error.message : String(error))
      throw error
    } finally { analysisInstallTask = null }
  })

  ipcMain.handle('pitchord:remove-harmony-model', async (event, modelId) => {
    if (event.sender !== mainWindow?.webContents || !harmonyModelCatalog.some(model => model.id === modelId)) throw new Error('Invalid harmony model removal request')
    const root = path.resolve(modelRoot(), 'harmony')
    const directory = path.resolve(root, modelId)
    if (!directory.startsWith(root + path.sep)) throw new Error('Invalid harmony model path')
    await fs.promises.rm(directory, { recursive: true, force: true })
    return analysisRuntimeStatus()
  })

  ipcMain.handle('pitchord:prepare-alignment-model', async (event, requestedModel = 'small') => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (analysisInstallTask) throw new Error('分析环境正在执行另一项操作，请稍候。')
    const selectedModel = alignmentModelCatalog.find(model => model.id === requestedModel)
    if (!selectedModel) throw new Error('不支持的歌词对齐模型。')
    analysisInstallTask = (async () => {
      await requireFreeSpace(requestedModel === 'small' ? 1024 * 1024 * 1024 : 512 * 1024 * 1024, '准备歌词对齐模型')
      const python = await preferredPythonPath()
      const probe = await probePython(python)
      if (!python || !probe?.fasterWhisper) throw new Error('歌词对齐组件尚未安装，请先检查或修复分析环境。')
      sendAnalysisProgress('alignment-model', `正在准备 ${selectedModel.label}…`)
      await ensureRecommendedAlignmentModel(python, requestedModel, (progress, message, detail, telemetry = {}) => {
        sendAnalysisProgress('alignment-model', message, { detail, ...telemetry })
        sendTaskProgress('alignment-model', '准备歌词对齐模型', 'running', message, progress)
      }, null, '准备歌词对齐模型')
      sendTaskProgress('alignment-model', '准备歌词对齐模型', 'success', `${selectedModel.label} 已准备完成`, 1)
      sendAnalysisProgress('complete', '歌词对齐模型已准备完成。')
      return { ...await analysisRuntimeStatus(), busy: false }
    })()
    try { return await analysisInstallTask }
    catch (error) {
      const message = readableModelError(error)
      sendTaskProgress('alignment-model', '准备歌词对齐模型', 'error', message)
      throw new Error(message)
    } finally { analysisInstallTask = null }
  })

  ipcMain.handle('pitchord:remove-alignment-model', async (event, modelId) => {
    if (event.sender !== mainWindow?.webContents || !alignmentModelCatalog.some(model => model.id === modelId)) throw new Error('Invalid alignment model removal request')
    const directory = path.resolve(alignmentModelDirectory(modelId))
    const root = path.resolve(alignmentModelRoot())
    if (!directory.startsWith(root + path.sep)) throw new Error('Invalid alignment model path')
    await fs.promises.rm(directory, { recursive: true, force: true })
    return analysisRuntimeStatus()
  })

  ipcMain.handle('pitchord:import-analysis-model', async (event, kind = 'separation') => {
    if (event.sender !== mainWindow?.webContents || !['separation', 'harmony', 'pitch'].includes(kind)) throw new Error('Invalid model import request')
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'pitch' ? '选择音高模型及配套配置' : kind === 'harmony' ? '选择去和声模型及配套配置' : '选择人声分离模型及配套配置',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '模型与配置', extensions: ['th', 'ckpt', 'pt', 'onnx', 'yaml', 'yml', 'json'] }],
    })
    if (picked.canceled || !picked.filePaths.length) return null
    const digest = createHash('sha256').update(picked.filePaths.join('|')).update(String(Date.now())).digest('hex').slice(0, 10)
    const id = `custom-${digest}`
    const directory = path.join(modelRoot(), 'custom', id)
    await mkdir(directory, { recursive: true })
    for (const file of picked.filePaths) await fs.promises.copyFile(file, path.join(directory, safeAssetName(path.basename(file))))
    const names = picked.filePaths.map(file => path.basename(file))
    const yaml = names.find(name => /\.ya?ml$/i.test(name))
    const demucsWeights = names.find(name => /\.th$/i.test(name))
    const checkpoint = names.find(name => /\.ckpt$/i.test(name))
    const provider = kind === 'separation' && demucsWeights ? 'demucs-local' : checkpoint ? 'msst' : kind === 'pitch' ? 'custom-pitch' : 'unknown'
    const modelType = provider === 'msst' ? inferMsstModelType(names) : null
    const copiedConfig = yaml ? path.join(directory, safeAssetName(yaml)) : null
    const supportsVocals = !!copiedConfig && msstConfigSupportsVocals(copiedConfig)
    const runnable = provider === 'demucs-local' || (provider === 'msst' && !!yaml && !!modelType && supportsVocals && fs.existsSync(path.join(msstRoot, 'inference.py')))
    const modelName = (yaml || demucsWeights || names[0]).replace(/\.[^.]+$/, '').replace(/-[a-f0-9]{8}$/i, '')
    const model = {
      id,
      label: names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 个文件`,
      description: provider === 'msst' && runnable ? `用户导入的 MSST ${modelType} ${kind === 'harmony' ? '去和声' : '人声'}模型；权重与 YAML 已复制到 Pitchord 环境。` : runnable ? '用户导入的 Demucs 本地模型；文件已复制到 Pitchord 环境。' : provider === 'msst' && yaml && modelType && !supportsVocals ? '这个 MSST 配置不包含 vocals 输出，不能用于当前步骤。' : provider === 'msst' ? 'MSST 权重已复制到 Pitchord 环境；还需要配套 YAML，且文件名需能识别 MelBandRoformer 或 BSRoformer 架构。' : '模型文件已复制到 Pitchord 环境；当前版本尚无可识别的推理提供者。',
      bundled: false,
      ready: true,
      runnable,
      source: 'custom',
      canDelete: true,
      provider,
      kind,
      modelName,
      modelType,
      checkpoint: checkpoint ? path.join(directory, safeAssetName(checkpoint)) : null,
      config: copiedConfig,
      directory,
      files: names,
      importedAt: new Date().toISOString(),
    }
    const models = readCustomModels().filter(item => item.id !== id)
    models.push(model)
    await writeCustomModels(models)
    return analysisRuntimeStatus()
  })

  ipcMain.handle('pitchord:remove-analysis-model', async (event, modelId) => {
    if (event.sender !== mainWindow?.webContents || typeof modelId !== 'string') throw new Error('Invalid model removal request')
    const custom = readCustomModels()
    const customEntry = custom.find(model => model.id === modelId)
    if (customEntry) {
      const directory = path.resolve(customEntry.directory)
      const customRoot = path.resolve(modelRoot(), 'custom')
      if (!directory.startsWith(customRoot + path.sep)) throw new Error('Invalid custom model path')
      await fs.promises.rm(directory, { recursive: true, force: true })
      await writeCustomModels(custom.filter(model => model.id !== modelId))
      return analysisRuntimeStatus()
    }
    const model = separationModelCatalog.find(item => item.id === modelId)
    if (!model) throw new Error('没有找到这个模型。')
    if (model.bundled) throw new Error('随软件提供的默认模型不能单独删除；可以在“存储与环境”中删除全部模型。')
    let marker = null
    try { marker = JSON.parse(await readFile(modelMarker(modelId), 'utf8')) } catch { /* already absent */ }
    for (const relative of marker?.files || []) {
      const file = path.resolve(modelRoot(), relative)
      if (file.startsWith(path.resolve(modelRoot()) + path.sep)) await fs.promises.rm(file, { force: true })
    }
    await fs.promises.rm(modelMarker(modelId), { force: true })
    return analysisRuntimeStatus()
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
    const inferred = inferExistingEnvironmentFromPython(picked.filePaths[0], pythonExecutable, baseRuntime.version)
    if (inferred) {
      await writeSettings({ analysisRoot: inferred.root, pythonPath: inferred.pythonPath, runtimePreference: 'existing' })
      configuredAnalysisRoot = inferred.root
    } else await rememberPythonPath(picked.filePaths[0])
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

  ipcMain.handle('pitchord:open-project', async (event, recentDirectory) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    let file
    if (recentDirectory === undefined) {
      const picked = await dialog.showOpenDialog(mainWindow, { title: '打开 Pitchord 工程', defaultPath: projectRoot(), properties: ['openFile'], filters: [{ name: 'Pitchord 工程', extensions: ['json'] }] })
      if (picked.canceled || !picked.filePaths[0]) return null
      file = picked.filePaths[0]
    } else {
      if (typeof recentDirectory !== 'string' || !path.isAbsolute(recentDirectory)) throw new Error('最近项目的目录无效。')
      file = path.join(path.resolve(recentDirectory), 'project.pitchord.json')
      if (!fs.existsSync(file)) throw new Error('最近项目文件已移动或删除。请使用“从文件夹打开项目”重新选择。')
    }
    const content = await readFile(file, 'utf8')
    const value = JSON.parse(content)
    if (value.version !== 1 || !Array.isArray(value.segments)) throw new Error('工程文件格式无效。')
    const directory = path.dirname(file)
    await Promise.all(['media', 'analysis', 'exports', 'lyrics', path.join('lyrics', 'sources'), path.join('lyrics', 'backups')].map(folder => mkdir(path.join(directory, folder), { recursive: true })))
    activeProject = { directory, name: value.name || path.basename(directory), assets: value.assets || {} }
    await queueProjectSave(activeProject, () => saveProjectManifest(activeProject, content))
    return { directory, name: activeProject.name, content }
  })

  const protectedProjectDirectories = () => [applicationDirectory(), projectRoot(), analysisRoot(), app.getPath('home'), app.getPath('documents')]

  ipcMain.handle('pitchord:refresh-projects', async (event, recentDirectories) => {
    if (event.sender !== mainWindow?.webContents || !Array.isArray(recentDirectories) || recentDirectories.length > 100) throw new Error('最近项目列表无效。')
    let defaultProjects = []
    try {
      const entries = await fs.promises.readdir(projectRoot(), { withFileTypes: true })
      defaultProjects = entries.filter(entry => entry.isDirectory()).map(entry => path.join(projectRoot(), entry.name))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const candidates = [...new Set([...recentDirectories.filter(directory => typeof directory === 'string' && path.isAbsolute(directory)), ...defaultProjects])].slice(0, 100)
    const projects = await Promise.all(candidates.map(async directory => {
      try {
        const project = await validatedProjectDirectory(directory, protectedProjectDirectories())
        const info = await fs.promises.stat(project.manifest)
        const name = [project.content.projectName, project.content.name].find(value => typeof value === 'string' && value.trim()) || path.basename(project.directory)
        return { directory: project.directory, name, updatedAt: info.mtime.toISOString(), available: true }
      } catch {
        return recentDirectories.includes(directory) ? { directory, name: path.basename(directory), updatedAt: '', available: false } : null
      }
    }))
    return projects.filter(Boolean).sort((a, b) => Number(b.available) - Number(a.available) || Date.parse(b.updatedAt || '1970-01-01') - Date.parse(a.updatedAt || '1970-01-01')).slice(0, 50)
  })

  ipcMain.handle('pitchord:duplicate-project', async (event, directory, name) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    return duplicateProject(directory, name, protectedProjectDirectories())
  })

  ipcMain.handle('pitchord:reveal-project', async (event, directory) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    const project = await validatedProjectDirectory(directory, protectedProjectDirectories())
    shell.showItemInFolder(project.directory)
  })

  ipcMain.handle('pitchord:trash-projects', async (event, directories) => {
    if (event.sender !== mainWindow?.webContents || !Array.isArray(directories) || !directories.length || directories.length > 50 || directories.some(directory => typeof directory !== 'string')) throw new Error('请选择有效的工程。')
    if (activeAnalysisTasks.size) throw new Error('分析任务仍在运行，请结束任务后再删除工程。')
    const unique = [...new Set(directories)]
    const projects = await Promise.all(unique.map(directory => validatedProjectDirectory(directory, protectedProjectDirectories())))
    const trashed = []
    const failed = []
    for (const project of projects) {
      try {
        await shell.trashItem(project.directory)
        if (activeProject?.directory === project.directory) activeProject = null
        trashed.push(project.directory)
      } catch (error) {
        failed.push({ directory: project.directory, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { trashed, failed }
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
    if (event.sender !== mainWindow?.webContents || !['media', 'vocals', 'harmonies', 'accompaniment'].includes(kind) || typeof name !== 'string' || !(data instanceof ArrayBuffer)) throw new Error('Invalid asset request')
    const project = requireProject()
    const folder = kind === 'media' ? 'media' : 'analysis'
    const baseName = `${kind === 'media' ? '' : `${kind}-`}${safeAssetName(name)}`
    const initial = path.join(folder, baseName)
    const relative = fs.existsSync(projectAssetPath(project, initial))
      ? path.join(folder, `${Date.now()}-${baseName}`)
      : initial
    await writeFile(projectAssetPath(project, relative), Buffer.from(data))
    project.assets[kind] = relative
    if (kind === 'vocals') delete project.assets.harmonies
    await saveProjectAssets(project)
    return projectAssetPath(project, relative)
  })

  ipcMain.handle('pitchord:read-project-asset', async (event, kind) => {
    if (event.sender !== mainWindow?.webContents || !['media', 'vocals', 'harmonies', 'accompaniment'].includes(kind)) throw new Error('Invalid asset request')
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
    pendingTaskCancellations.delete('separation')
    const selectedModel = separationModel(sourceData.model || analysisModel)
    const project = requireProject()
    const workDir = path.join(project.directory, 'analysis', `separation-${selectedModel.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    await mkdir(workDir, { recursive: true })
    const script = path.join(scriptRoot, 'separate-vocals.py')
    const localPython = await preferredPythonPath() || pythonExecutable
    const python = fs.existsSync(localPython) ? localPython : 'python'
    const bundledFfmpeg = resolveBundledBinary(ffmpegPath, 'ffmpeg-static')
    const bundledFfprobe = resolveBundledBinary(ffprobePath, 'ffprobe-static')
    const childEnv = analysisEnvironment(python)
    const computeProbe = await probePython(python)
    const computeDevice = computeProbe?.cudaAvailable ? 'cuda' : 'cpu'
    const binaryDirs = [bundledFfmpeg, bundledFfprobe].filter(binary => binary && fs.existsSync(binary)).map(binary => path.dirname(binary))
    if (binaryDirs.length) childEnv.PATH = `${[...new Set(binaryDirs)].join(path.delimiter)}${path.delimiter}${childEnv.PATH || ''}`
    const source = project.assets.media ? projectAssetPath(project, project.assets.media) : path.join(project.directory, 'media', safeAssetName(sourceData.name))
    if (!project.assets.media) {
      await writeFile(source, Buffer.from(sourceData.data))
      project.assets.media = path.relative(project.directory, source)
    }
    sendTaskProgress('separation', '人声分离', 'running', `正在使用 ${selectedModel.label}（${computeProbe?.cudaAvailable ? computeProbe.cudaDeviceName || 'CUDA GPU' : 'CPU'}）处理 ${path.basename(source)}…`, 0.03)
    try {
      let args
      if (selectedModel.provider === 'msst') {
        const inputDirectory = path.join(workDir, 'input')
        fs.mkdirSync(inputDirectory, { recursive: true })
        fs.copyFileSync(source, path.join(inputDirectory, safeAssetName(path.basename(source))))
        args = [
          path.join(msstRoot, 'inference.py'),
          '--model_type', selectedModel.modelType,
          '--config_path', selectedModel.config,
          '--start_check_point', selectedModel.checkpoint,
          '--input_folder', inputDirectory,
          '--store_dir', workDir,
          '--extract_instrumental',
          '--disable_detailed_pbar',
        ]
        if (!computeProbe?.cudaAvailable) args.push('--force_cpu')
      } else {
        args = [script, source, '--output', workDir, '--model', selectedModel.modelName || selectedModel.id, '--device', computeDevice]
        if (selectedModel.provider === 'demucs-local') args.push('--repo', selectedModel.directory)
      }
      await runProcess(python, args, {
        env: childEnv,
        taskId: 'separation',
        taskTitle: '人声分离',
        onOutput: chunk => {
          const output = String(chunk)
          const line = output.trim().split(/\r?\n/).at(-1)
          const percentage = line?.match(/(\d{1,3})%/)?.[1]
          if (line) sendTaskProgress('separation', '人声分离', 'running', line.slice(-240), percentage ? Math.min(0.95, Number(percentage) / 100) : undefined)
        },
      })
    } catch (error) {
      if (isTaskCancelled(error)) {
        await fs.promises.rm(workDir, { recursive: true, force: true })
        sendTaskProgress('separation', '人声分离', 'cancelled', '已取消运行')
        throw error
      }
      const detail = error instanceof Error ? error.message : String(error)
      let mapped = error instanceof Error ? error : new Error(detail)
      if (/No module named ['"](?:demucs|omegaconf|ml_collections|beartype|rotary_embedding_torch)['"]/.test(detail)) mapped = new Error('当前分析环境缺少所选分离模型需要的推理组件，请先使用“检查或修复环境”。')
      else if (/ffmpeg|ffprobe/i.test(detail)) mapped = new Error('处理视频需要 FFmpeg，但当前运行环境无法使用它。请重新安装包含 FFmpeg 的桌面版本。')
      else if (/checkpoint|download|connection|model/i.test(detail)) mapped = new Error(`分离模型加载或下载失败：${detail.slice(-3000)}`)
      sendTaskProgress('separation', '人声分离', 'error', mapped.message)
      throw mapped
    }
    const findVocals = async (folder, filename) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name)
        if (entry.isDirectory()) { const found = await findVocals(full, filename); if (found) return found }
        else if (entry.name.toLowerCase() === filename) return full
      }
      return null
    }
    const generatedVocals = await findVocals(workDir, 'vocals.wav')
    const generatedAccompaniment = await findVocals(workDir, selectedModel.provider === 'msst' ? 'instrumental.wav' : 'no_vocals.wav')
    if (!generatedVocals || !generatedAccompaniment) throw new Error('人声分离没有生成预期的纯人声与纯伴奏文件。')
    const resultSuffix = safeAssetName(selectedModel.id).replace(/\.[^.]+$/, '')
    const vocals = path.join(workDir, `vocals-${resultSuffix}.wav`)
    const accompaniment = path.join(workDir, `accompaniment-${resultSuffix}.wav`)
    await fs.promises.rename(generatedVocals, vocals)
    await fs.promises.rename(generatedAccompaniment, accompaniment)
    project.assets.vocals = path.relative(project.directory, vocals)
    delete project.assets.harmonies
    project.assets.accompaniment = path.relative(project.directory, accompaniment)
    await mkdir(path.dirname(modelMarker(selectedModel.id)), { recursive: true })
    await writeFile(modelMarker(selectedModel.id), JSON.stringify({ model: selectedModel.id, preparedAt: new Date().toISOString() }, null, 2), 'utf8')
    await saveProjectAssets(project)
    sendTaskProgress('separation', '人声分离', 'success', `${selectedModel.label} 已生成人声和伴奏`, 1)
    return { vocals: { name: path.basename(vocals), path: vocals, data: await readFile(vocals) }, accompaniment: { name: path.basename(accompaniment), path: accompaniment, data: await readFile(accompaniment) } }
  })

  ipcMain.handle('pitchord:separate-harmonies', async (event, request) => {
    if (event.sender !== mainWindow?.webContents || typeof request?.vocals !== 'string' || typeof request?.model !== 'string') throw new Error('Invalid harmony separation request')
    pendingTaskCancellations.delete('harmony')
    const project = requireProject()
    const input = resolvePitchInput(project, request.vocals, '去和声')
    const selectedModel = harmonyModel(request.model)
    const workDir = path.join(project.directory, 'analysis', `harmony-${selectedModel.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    const inputDirectory = path.join(workDir, 'input')
    await mkdir(inputDirectory, { recursive: true })
    await fs.promises.copyFile(input, path.join(inputDirectory, 'vocals.wav'))
    const python = await preferredPythonPath()
    const probe = await probePython(python)
    if (!python || !probe?.demucs) throw new Error('请先安装或修复分析环境。')
    const args = [
      path.join(msstRoot, 'inference.py'),
      '--model_type', selectedModel.modelType,
      '--config_path', selectedModel.config,
      '--start_check_point', selectedModel.checkpoint,
      '--input_folder', inputDirectory,
      '--store_dir', workDir,
      '--extract_instrumental',
      '--disable_detailed_pbar',
    ]
    if (!probe.cudaAvailable) args.push('--force_cpu')
    sendTaskProgress('harmony', '提取主唱并剥离和声', 'running', `正在使用 ${selectedModel.label} 处理人声轨…`, 0.02)
    try {
      await runProcess(python, args, {
        env: analysisEnvironment(python), taskId: 'harmony', taskTitle: '提取主唱并剥离和声',
        onOutput: chunk => {
          const line = String(chunk).trim().split(/\r?\n/).at(-1)
          const percentage = line?.match(/(\d{1,3})%/)?.[1]
          if (line) sendTaskProgress('harmony', '提取主唱并剥离和声', 'running', line.slice(-240), percentage ? Math.min(0.95, Number(percentage) / 100) : undefined)
        },
      })
      const leadFile = await findGeneratedStem(workDir, 'vocals.wav')
      const harmonyFile = await findGeneratedStem(workDir, 'instrumental.wav')
      if (!leadFile || !harmonyFile) throw new Error('去和声模型没有生成主唱与和声两条音轨。')
      const lead = path.join(workDir, 'lead-vocals.wav')
      const harmonies = path.join(workDir, 'harmonies.wav')
      await fs.promises.rename(leadFile, lead)
      await fs.promises.rename(harmonyFile, harmonies)
      project.assets.vocals = path.relative(project.directory, lead)
      project.assets.harmonies = path.relative(project.directory, harmonies)
      await saveProjectAssets(project)
      sendTaskProgress('harmony', '提取主唱并剥离和声', 'success', '主唱已作为音高与歌词对齐输入；和声已单独保留', 1)
      return {
        lead: { name: path.basename(lead), path: lead, data: await readFile(lead) },
        harmonies: { name: path.basename(harmonies), path: harmonies, data: await readFile(harmonies) },
        modelId: selectedModel.id, modelLabel: selectedModel.label,
      }
    } catch (error) {
      if (isTaskCancelled(error)) {
        await fs.promises.rm(workDir, { recursive: true, force: true })
        sendTaskProgress('harmony', '提取主唱并剥离和声', 'cancelled', '已取消运行')
      } else sendTaskProgress('harmony', '提取主唱并剥离和声', 'error', error instanceof Error ? error.message : String(error))
      throw error
    }
  })

  ipcMain.handle('pitchord:analyze-pitch', async (event, algorithm = 'pyin', selectedVocals) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid sender')
    if (!Object.hasOwn(pitchMethodLabels, algorithm)) throw new Error('当前音高算法尚不可用。')
    pendingTaskCancellations.delete('pitch')
    const project = requireProject()
    const input = resolvePitchInput(project, selectedVocals)
    const output = path.join(project.directory, 'analysis', `pitch-${algorithm}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    const python = await preferredPythonPath()
    const probe = await probePython(python)
    if (!python || !probe) throw new Error('分析环境中的 Python 无法启动，请打开“分析环境”重新检测或修复。')
    if (!probe.librosa) throw new Error('音高识别所需的公共音频组件尚未安装，请打开“分析环境”重新准备所选环境；无需删除已下载的模型。')
    if ((algorithm === 'torchcrepe' && !probe.torchcrepe) || (algorithm === 'rmvpe' && (!probe.rmvpe || !fs.existsSync(rmvpeModelPath()))) || (algorithm === 'fcpe' && !probe.fcpe)) throw new Error(`分析环境尚未准备 ${pitchMethodLabels[algorithm]}，请在分析环境中选择并安装。`)
    const computeDevice = (algorithm === 'torchcrepe' || algorithm === 'fcpe') && probe.cudaAvailable ? 'cuda' : 'cpu'
    const deviceLabel = computeDevice === 'cuda' ? probe.cudaDeviceName || 'CUDA GPU' : 'CPU'
    sendTaskProgress('pitch', '连续音高识别', 'running', `正在使用 ${deviceLabel} 启动 ${pitchMethodLabels[algorithm]}…`, 0.02)
    try {
      await runProcess(python, [path.join(scriptRoot, 'analyze-pitch.py'), input, '--algorithm', algorithm, '--output', output, '--device', computeDevice, ...(algorithm === 'rmvpe' ? ['--model', rmvpeModelPath()] : [])], {
        env: analysisEnvironment(python),
        taskId: 'pitch',
        taskTitle: '连续音高识别',
        onOutput: chunk => {
          for (const line of chunk.split(/\r?\n/)) {
            const match = line.match(/^PITCHORD_PROGRESS\|([\d.]+)\|(.*)$/)
            if (match) sendTaskProgress('pitch', '连续音高识别', 'running', match[2], Number(match[1]))
          }
        },
      })
      const result = JSON.parse(await readFile(output, 'utf8'))
      if (!Array.isArray(result.points) || !result.points.every(point => Number.isFinite(point.time) && Number.isFinite(point.hz) && Number.isFinite(point.confidence) && Number.isFinite(point.rms) && typeof point.voiced === 'boolean')) throw new Error('音高分析结果格式无效。')
      sendTaskProgress('pitch', '连续音高识别', 'success', `${pitchMethodLabels[algorithm]} 已用 ${result.device || deviceLabel} 生成 ${result.points.length} 个时间点`, 1)
      return { algorithm, path: output, points: result.points, device: result.device || deviceLabel }
    } catch (error) {
      if (isTaskCancelled(error)) {
        await fs.promises.rm(output, { force: true })
        sendTaskProgress('pitch', '连续音高识别', 'cancelled', '已取消运行')
        throw error
      }
      sendTaskProgress('pitch', '连续音高识别', 'error', error instanceof Error ? error.message : String(error))
      throw error
    }
  })

  ipcMain.handle('pitchord:align-lyrics', async (event, request) => {
    if (event.sender !== mainWindow?.webContents || !request || !Array.isArray(request.segments) || !Number.isFinite(request.duration)) throw new Error('Invalid lyric alignment request')
    pendingTaskCancellations.delete('alignment')
    const selectedModel = alignmentModelCatalog.find(model => model.id === (request.model || 'small'))
    if (!selectedModel) throw new Error('不支持的歌词对齐模型。')
    if (!fs.existsSync(alignmentModelMarker(selectedModel.id))) throw new Error(`请先在模型管理中准备 ${selectedModel.label}。`)
    const project = requireProject()
    const analysisDirectory = path.resolve(project.directory, 'analysis')
    let vocals = request.vocals ? path.resolve(request.vocals) : project.assets.vocals ? projectAssetPath(project, project.assets.vocals) : ''
    if (!vocals || !fs.existsSync(vocals)) throw new Error('请选择一条仍然存在的纯人声分离结果。')
    if (!vocals.startsWith(analysisDirectory + path.sep)) throw new Error('歌词对齐只能读取当前工程的纯人声结果。')
    const suffix = `${selectedModel.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const input = path.join(analysisDirectory, `alignment-input-${suffix}.json`)
    const output = path.join(analysisDirectory, `lyrics-alignment-${suffix}.json`)
    await writeFile(input, JSON.stringify({ segments: request.segments, duration: request.duration, pitchPoints: Array.isArray(request.pitchPoints) ? request.pitchPoints : [] }, null, 2), 'utf8')
    const python = await preferredPythonPath()
    const probe = await probePython(python)
    if (!python || !probe?.fasterWhisper) throw new Error('歌词对齐组件尚未安装，请先检查或修复分析环境。')
    const computeDevice = probe.ctranslateCudaAvailable ? 'cuda' : 'cpu'
    const deviceLabel = computeDevice === 'cuda' ? probe.cudaDeviceName || 'CUDA GPU' : 'CPU'
    sendTaskProgress('alignment', '歌词时间戳匹配', 'running', `正在使用 ${selectedModel.label}（${deviceLabel}）识别人声音轨…`, 0.02)
    try {
      await runProcess(python, [
        path.join(scriptRoot, 'align-lyrics.py'), vocals,
        '--lyrics', input,
        '--output', output,
        '--model', selectedModel.id,
        '--language', typeof request.language === 'string' ? request.language : 'zh',
        '--model-root', alignmentModelRoot(),
        '--device', computeDevice,
      ], {
        env: analysisEnvironment(python),
        taskId: 'alignment',
        taskTitle: '歌词时间戳匹配',
        onOutput: outputText => {
          for (const line of outputText.split(/\r?\n/)) {
            if (!line || /unauthenticated requests|HF_TOKEN/i.test(line)) continue
            const progress = line.match(/^PITCHORD_PROGRESS\|([\d.]+)\|(.*)$/)
            if (progress) sendTaskProgress('alignment', '歌词时间戳匹配', 'running', progress[2], Number(progress[1]))
          }
        },
      })
      const result = JSON.parse(await readFile(output, 'utf8'))
      if (!Array.isArray(result.segments) || !Number.isFinite(result.coverage)) throw new Error('歌词对齐结果格式无效。')
      sendTaskProgress('alignment', '歌词时间戳匹配', 'success', `匹配完成，歌词覆盖率 ${Math.round(result.coverage * 100)}%，${result.lowConfidenceLines?.length || 0} 句建议复核`, 1)
      return { ...result, path: output, input: vocals }
    } catch (error) {
      if (isTaskCancelled(error)) {
        await Promise.all([fs.promises.rm(input, { force: true }), fs.promises.rm(output, { force: true })])
        sendTaskProgress('alignment', '歌词时间戳匹配', 'cancelled', '已取消运行')
        throw error
      }
      const message = readableModelError(error)
      sendTaskProgress('alignment', '歌词时间戳匹配', 'error', message)
      throw new Error(message)
    }
  })

  ipcMain.handle('pitchord:read-analysis-file', async (event, file) => {
    if (event.sender !== mainWindow?.webContents || typeof file !== 'string') throw new Error('Invalid analysis file request')
    const project = requireProject()
    const absolute = path.resolve(file)
    const analysisDirectory = path.resolve(project.directory, 'analysis')
    if (!absolute.startsWith(analysisDirectory + path.sep)) throw new Error('只能读取当前工程的分析结果。')
    return readFile(absolute)
  })

  ipcMain.handle('pitchord:activate-separation-result', async (event, result) => {
    if (event.sender !== mainWindow?.webContents || typeof result?.vocals !== 'string' || typeof result?.accompaniment !== 'string') throw new Error('Invalid separation result')
    const project = requireProject()
    const analysisDirectory = path.resolve(project.directory, 'analysis')
    const vocals = path.resolve(result.vocals)
    const accompaniment = path.resolve(result.accompaniment)
    if (!vocals.startsWith(analysisDirectory + path.sep) || !accompaniment.startsWith(analysisDirectory + path.sep) || !fs.existsSync(vocals) || !fs.existsSync(accompaniment)) throw new Error('这个分离结果文件已经不存在。')
    project.assets.vocals = path.relative(project.directory, vocals)
    delete project.assets.harmonies
    project.assets.accompaniment = path.relative(project.directory, accompaniment)
    await saveProjectAssets(project)
    return true
  })

  ipcMain.handle('pitchord:activate-vocal-result', async (event, result) => {
    if (event.sender !== mainWindow?.webContents || typeof result?.vocals !== 'string') throw new Error('Invalid vocal result')
    const project = requireProject()
    const analysisDirectory = path.resolve(project.directory, 'analysis')
    const vocals = path.resolve(result.vocals)
    if (!vocals.startsWith(analysisDirectory + path.sep) || !fs.existsSync(vocals)) throw new Error('这个纯人声结果文件已经不存在。')
    const harmonies = result.harmonies ? path.resolve(result.harmonies) : null
    if (harmonies && (!harmonies.startsWith(analysisDirectory + path.sep) || !fs.existsSync(harmonies))) throw new Error('这个和声结果文件已经不存在。')
    project.assets.vocals = path.relative(project.directory, vocals)
    if (harmonies) project.assets.harmonies = path.relative(project.directory, harmonies)
    else delete project.assets.harmonies
    await saveProjectAssets(project)
    return true
  })

  ipcMain.handle('pitchord:burn-subtitles', async (event, request) => {
    if (event.sender !== mainWindow?.webContents || typeof request?.ass !== 'string' || request.ass.length > 50_000_000 || typeof request?.outputName !== 'string') throw new Error('Invalid subtitle render request')
    const project = requireProject()
    if (!project.assets.media) throw new Error('当前工程没有原始媒体。')
    const source = projectAssetPath(project, project.assets.media)
    if (!/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(source)) throw new Error('嵌入字幕需要视频源；当前工程导入的是音频。')
    const ffmpeg = resolveBundledBinary(ffmpegPath, 'ffmpeg-static')
    if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('当前安装包缺少 FFmpeg，无法嵌入字幕。')
    const exportsDirectory = path.join(project.directory, 'exports')
    await mkdir(exportsDirectory, { recursive: true })
    const base = safeAssetName(request.outputName).replace(/\.(mp4|ass)$/i, '') || 'Pitchord-subtitled'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const subtitle = path.join(exportsDirectory, `${base}-${stamp}.ass`)
    const video = path.join(exportsDirectory, `${base}-${stamp}.mp4`)
    await writeFile(subtitle, request.ass, 'utf8')
    let projectDuration = 0
    try { projectDuration = Number(JSON.parse(await readFile(path.join(project.directory, 'project.pitchord.json'), 'utf8')).duration) || 0 } catch { /* progress remains indeterminate */ }
    const filterPath = subtitle.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'")
    sendTaskProgress('subtitle-render', '嵌入视频字幕', 'running', '正在启动视频渲染…', 0.01)
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(ffmpeg, ['-y', '-i', source, '-vf', `ass='${filterPath}'`, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-progress', 'pipe:1', '-nostats', video], { windowsHide: true })
        let stderr = ''
        child.stdout.on('data', chunk => {
          const output = String(chunk)
          const match = output.match(/out_time_(?:ms|us)=(\d+)/)
          const seconds = match ? Number(match[1]) / 1_000_000 : 0
          if (projectDuration > 0 && seconds > 0) sendTaskProgress('subtitle-render', '嵌入视频字幕', 'running', `正在渲染 ${Math.min(projectDuration, seconds).toFixed(1)} / ${projectDuration.toFixed(1)} 秒`, Math.min(0.98, seconds / projectDuration))
        })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve(undefined) : reject(new Error(stderr.slice(-4000) || `FFmpeg exited with ${code}`)))
      })
      sendTaskProgress('subtitle-render', '嵌入视频字幕', 'success', '带字幕视频已保存到工程 exports 文件夹', 1)
      return { video, subtitle }
    } catch (error) {
      await fs.promises.rm(video, { force: true })
      sendTaskProgress('subtitle-render', '嵌入视频字幕', 'error', error instanceof Error ? error.message : String(error))
      throw error
    }
  })

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
