const fs = require('node:fs/promises')
const path = require('node:path')

const manifestName = 'project.pitchord.json'

async function validatedProjectDirectory(directory, protectedDirectories = []) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('工程目录无效。')
  const resolved = path.resolve(directory)
  const root = path.parse(resolved).root
  const protectedPaths = protectedDirectories.map(item => path.resolve(item))
  if (resolved === root || protectedPaths.includes(resolved)) throw new Error('不能操作此目录。')
  const entry = await fs.lstat(resolved)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('工程目录不是普通文件夹。')
  const manifest = path.join(resolved, manifestName)
  const manifestEntry = await fs.lstat(manifest)
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw new Error('工程文件无效。')
  const content = JSON.parse(await fs.readFile(manifest, 'utf8'))
  if (content.version !== 1 || !Array.isArray(content.segments)) throw new Error('工程文件格式无效。')
  return { directory: resolved, manifest, content }
}

function validateProjectName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || name.trim().endsWith('.') || Array.from(name).some(character => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character))) {
    throw new Error('工程名称包含无效字符。')
  }
  return name.trim()
}

function rebaseProjectPaths(content, source, destination, name) {
  const rebase = value => typeof value === 'string' && path.isAbsolute(value) && (path.resolve(value) === source || path.resolve(value).startsWith(`${source}${path.sep}`))
    ? path.join(destination, path.relative(source, value))
    : value
  return {
    ...content,
    name,
    projectName: name,
    separationResults: Array.isArray(content.separationResults) ? content.separationResults.map(item => ({
      ...item,
      vocals: rebase(item.vocals),
      accompaniment: rebase(item.accompaniment),
      harmonies: rebase(item.harmonies),
      sourceVocals: rebase(item.sourceVocals),
    })) : content.separationResults,
    pitchResults: Array.isArray(content.pitchResults) ? content.pitchResults.map(item => ({ ...item, path: rebase(item.path) })) : content.pitchResults,
    alignmentResults: Array.isArray(content.alignmentResults) ? content.alignmentResults.map(item => ({ ...item, path: rebase(item.path) })) : content.alignmentResults,
  }
}

async function duplicateProject(directory, name, protectedDirectories = []) {
  const source = await validatedProjectDirectory(directory, protectedDirectories)
  const copyName = validateProjectName(name)
  const destination = path.join(path.dirname(source.directory), copyName)
  if (destination === source.directory) throw new Error('副本名称不能与原工程相同。')
  try {
    await fs.lstat(destination)
    throw new Error('同名工程目录已存在，请换一个名称。')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const staging = await fs.mkdtemp(path.join(path.dirname(source.directory), '.pitchord-copy-'))
  const stagedProject = path.join(staging, 'project')
  try {
    await fs.cp(source.directory, stagedProject, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async entry => {
        if ((await fs.lstat(entry)).isSymbolicLink()) throw new Error('工程包含快捷方式或链接目录，无法安全复制。')
        return true
      },
    })
    const copied = rebaseProjectPaths(source.content, source.directory, destination, copyName)
    await fs.writeFile(path.join(stagedProject, manifestName), JSON.stringify(copied, null, 2), 'utf8')
    await fs.rename(stagedProject, destination)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
  await fs.rm(staging, { recursive: true, force: true })
  return { directory: destination, name: copyName }
}

module.exports = { validatedProjectDirectory, validateProjectName, rebaseProjectPaths, duplicateProject }
