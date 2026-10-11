import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { validatedProjectDirectory, duplicateProject, rebaseProjectPaths } = require('../electron/project-operations.cjs')

test('copy preserves files and retargets analysis references without changing source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-project-test-'))
  try {
    const source = path.join(root, 'Song')
    await fs.mkdir(path.join(source, 'media'), { recursive: true })
    await fs.mkdir(path.join(source, 'analysis'), { recursive: true })
    await fs.writeFile(path.join(source, 'media', 'song.wav'), 'audio')
    await fs.writeFile(path.join(source, 'analysis', 'vocals.wav'), 'vocals')
    const data = {
      version: 1, name: 'Song', projectName: 'Song', segments: [],
      assets: { media: path.join('media', 'song.wav') },
      separationResults: [{ vocals: path.join(source, 'analysis', 'vocals.wav'), accompaniment: 'external.wav' }],
      pitchResults: [{ path: path.join(source, 'analysis', 'pitch.json') }],
      alignmentResults: [{ path: path.join(source, 'analysis', 'alignment.json') }],
    }
    await fs.writeFile(path.join(source, 'project.pitchord.json'), JSON.stringify(data))
    const duplicate = await duplicateProject(source, 'Song - 副本')
    const copied = JSON.parse(await fs.readFile(path.join(duplicate.directory, 'project.pitchord.json'), 'utf8'))
    const original = JSON.parse(await fs.readFile(path.join(source, 'project.pitchord.json'), 'utf8'))
    assert.equal(copied.projectName, 'Song - 副本')
    assert.equal(copied.separationResults[0].vocals, path.join(duplicate.directory, 'analysis', 'vocals.wav'))
    assert.equal(copied.separationResults[0].accompaniment, 'external.wav')
    assert.equal(copied.pitchResults[0].path, path.join(duplicate.directory, 'analysis', 'pitch.json'))
    assert.equal(copied.assets.media, data.assets.media)
    assert.equal(await fs.readFile(path.join(duplicate.directory, 'media', 'song.wav'), 'utf8'), 'audio')
    assert.deepEqual(original, data)
    await assert.rejects(duplicateProject(source, 'Song - 副本'), /同名工程目录已存在/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('project validation rejects broad and non-project directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchord-project-test-'))
  try {
    await assert.rejects(validatedProjectDirectory(root, [root]), /不能操作此目录/)
    await assert.rejects(validatedProjectDirectory(root), /ENOENT/)
    await assert.rejects(duplicateProject(root, 'Bad/Name'), /ENOENT/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('path rebasing only changes references inside the source project', () => {
  const source = path.resolve('source-project')
  const destination = path.resolve('copy-project')
  const outside = path.resolve('source-project-other', 'vocals.wav')
  const copied = rebaseProjectPaths({ version: 1, segments: [], separationResults: [{ vocals: path.join(source, 'analysis', 'vocals.wav'), harmonies: outside }] }, source, destination, 'Copy')
  assert.equal(copied.separationResults[0].vocals, path.join(destination, 'analysis', 'vocals.wav'))
  assert.equal(copied.separationResults[0].harmonies, outside)
})
