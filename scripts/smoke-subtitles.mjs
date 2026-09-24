import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, args, { windowsHide: true })
  let error = ''
  child.stderr.on('data', chunk => { error += String(chunk) })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(error.slice(-4000))))
})

const directory = await mkdtemp(path.join(tmpdir(), 'pitchord-subtitle-smoke-'))
try {
  const source = path.join(directory, 'source.mp4')
  const subtitle = path.join(directory, 'subtitle.ass')
  const output = path.join(directory, 'output.mp4')
  await writeFile(subtitle, `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Main,Arial,36,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Main,,0,0,0,,{\\c&H0000FFFF&}Pitchord・A4\n`, 'utf8')
  await run(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', source])
  const filterPath = subtitle.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'")
  await run(['-y', '-i', source, '-vf', `ass='${filterPath}'`, '-c:v', 'libx264', '-c:a', 'aac', output])
  const details = await stat(output)
  if (details.size < 1000) throw new Error('Rendered subtitle video is unexpectedly small')
  console.log(`Subtitle rendering smoke test passed (${details.size} bytes).`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
