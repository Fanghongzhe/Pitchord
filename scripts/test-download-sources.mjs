import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { orderedDownloadSources, downloadFromSources } = require('../electron/download-sources.cjs')

const official = { label: '官方', url: 'https://example.com/official' }
const mirrors = [{ label: '镜像 A', url: 'https://example.com/a' }, { label: '镜像 B', url: 'https://example.com/b' }]

test('domestic and official preferences order every source without dropping fallbacks', () => {
  assert.deepEqual(orderedDownloadSources(official, mirrors, true).map(source => source.label), ['镜像 A', '镜像 B', '官方'])
  assert.deepEqual(orderedDownloadSources(official, mirrors, false).map(source => source.label), ['官方', '镜像 A', '镜像 B'])
})

test('continues to the next source and reports the failing line', async () => {
  const attempted = []
  const reports = []
  const selected = await downloadFromSources([mirrors[0], official], async source => {
    attempted.push(source.label)
    if (source === mirrors[0]) throw new Error('连接超时')
  }, (source, reason, next) => reports.push([source.label, reason, next.label]))
  assert.equal(selected, official)
  assert.deepEqual(attempted, ['镜像 A', '官方'])
  assert.deepEqual(reports, [['镜像 A', '连接超时', '官方']])
})

test('shows every failed source rather than hiding the original errors', async () => {
  await assert.rejects(downloadFromSources([mirrors[0], official], async source => {
    throw new Error(`${source.label}失败`)
  }), /镜像 A：镜像 A失败；官方：官方失败/)
})

test('does not switch lines for local disk errors', async () => {
  const attempted = []
  await assert.rejects(downloadFromSources([mirrors[0], official], async source => {
    attempted.push(source.label)
    const error = new Error('磁盘空间不足')
    error.code = 'ENOSPC'
    throw error
  }), /磁盘空间不足/)
  assert.deepEqual(attempted, ['镜像 A'])
})

test('does not switch to another line after the user cancels', async () => {
  const attempted = []
  await assert.rejects(downloadFromSources([mirrors[0], official], async source => {
    attempted.push(source.label)
    const error = new Error('任务已取消。')
    error.name = 'TaskCancelledError'
    throw error
  }), { name: 'TaskCancelledError' })
  assert.deepEqual(attempted, ['镜像 A'])
})
