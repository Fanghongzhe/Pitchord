const path = require('node:path')
const packageJson = require('../package.json')

module.exports = {
  ...packageJson.build,
  directories: { ...packageJson.build.directories, output: 'release-desktop-online' },
  win: { ...packageJson.build.win, target: ['nsis'] },
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'Pitchord-${version}-${arch}-online-setup.${ext}',
    include: path.join(__dirname, 'installer.nsh'),
  },
}
