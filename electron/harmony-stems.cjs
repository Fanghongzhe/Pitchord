const { readdir } = require('node:fs/promises')
const path = require('node:path')

async function findGeneratedStem(directory, filename) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'input') {
      const found = await findGeneratedStem(path.join(directory, entry.name), filename)
      if (found) return found
    } else if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return path.join(directory, entry.name)
  }
  return null
}

module.exports = { findGeneratedStem }
