const fs = require('node:fs')
const path = require('node:path')

function resolvePitchInput(project, selectedVocals, purpose = '音高识别') {
  const analysisDirectory = path.resolve(project.directory, 'analysis')
  const input = selectedVocals
    ? path.resolve(selectedVocals)
    : project.assets.vocals
      ? path.resolve(project.directory, project.assets.vocals)
      : ''
  if (!input) throw new Error('请先运行人声分离或导入纯人声轨。')
  if (!input.startsWith(analysisDirectory + path.sep)) throw new Error(`${purpose}只能读取当前工程的纯人声结果。`)
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error('所选纯人声结果文件已经不存在，请重新选择或运行人声分离。')
  return input
}

module.exports = { resolvePitchInput }
