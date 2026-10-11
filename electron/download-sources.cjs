function orderedDownloadSources(official, mirrors, preferDomestic = true) {
  return preferDomestic ? [...mirrors, official] : [official, ...mirrors]
}

async function downloadFromSources(sources, download, onFailure) {
  if (!sources.length) throw new Error('没有可用的下载线路。')
  const failures = []
  for (const [index, source] of sources.entries()) {
    try {
      await download(source)
      return source
    } catch (error) {
      if (['ENOSPC', 'EACCES', 'EPERM'].includes(error?.code)) throw error
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${source.label}：${reason}`)
      if (index < sources.length - 1) onFailure?.(source, reason, sources[index + 1])
    }
  }
  throw new Error(`所有下载线路均失败。${failures.join('；')}`)
}

module.exports = { orderedDownloadSources, downloadFromSources }
