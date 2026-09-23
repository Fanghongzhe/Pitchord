const path = require('node:path')
const packageJson = require('../package.json')

module.exports = {
  ...packageJson.build,
  electronDist: path.join(__dirname, '..', 'node_modules', 'electron', 'dist'),
  directories: { ...packageJson.build.directories, output: 'release-desktop-bundle' },
  extraFiles: [
    { from: 'offline-analysis/prepared-analysis', to: 'environment' },
  ],
  win: { ...packageJson.build.win, target: ['dir'] },
}
