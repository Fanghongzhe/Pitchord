import { describe, expect, it } from 'vitest'
import { createSegment, retimeSegment } from './lyrics'
import { pitchForChar, pitchNotation } from './pitch'
import { defaultSubtitleStyle, detectedPitchRange, generatePitchAss, pitchColor, rawPitchAt, rawPitchLabel, recommendedPitchColorRules, sentenceSrt, subtitleFrameAt, subtitleUnitCenterX, wordTimedSubtitles } from './subtitles'

describe('word timed subtitle export', () => {
  it('keeps the edited timing for every lyric unit', () => {
    const segment = createSegment('你 好', 1, 3)
    segment.chars[0].end = 1.6
    segment.chars[1].start = 2.1
    const output = wordTimedSubtitles([segment])
    expect(output[0].words).toEqual([
      { text: '你', start: 1, end: 1.6 },
      { text: '好', start: 2.1, end: 3 },
    ])
  })

  it('creates pitch labels, emphasis dots and a highlighted active unit', () => {
    const segment = createSegment('你好', 1, 3)
    const output = generatePitchAss([segment], [
      { time: 1.1, hz: 440, confidence: 0.9, rms: 0.2, voiced: true },
      { time: 1.7, hz: 493.88, confidence: 0.9, rms: 0.2, voiced: true },
    ])
    expect(output).toContain('A4')
    expect(output).toContain('\\p1')
    expect(output).toContain('Dialogue: 0,0:00:01.00')
    expect(output).toMatch(/\\c&H[0-9A-F]{8}&/)
  })

  it('keeps the final pitch state until the next unit starts', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].end = 0.5
    segment.chars[1].start = 1.25
    const output = generatePitchAss([segment], [
      { time: 0.2, hz: 440, confidence: 1, rms: 0.2, voiced: true },
    ])
    expect(output).toContain('0:00:00.50,0:00:02.00,Pitch')
    expect(subtitleFrameAt([segment], [], 0.8)?.activeIndex).toBe(-1)
    expect(output).not.toContain('Dialogue: 1,0:00:00.50,0:00:01.25,Dot')
  })

  it('starts future glyphs in the base color and holds each sung glyph at its final pitch', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'C4', start: 0, end: 0.5 },
      { note: 'C5', start: 0.5, end: 1 },
    ] }
    segment.chars[1].pitchOverride = { motion: 'flat', notes: [{ note: 'A4', start: 0, end: 1 }] }
    const before = subtitleFrameAt([segment], [], 0.2)!
    const after = subtitleFrameAt([segment], [], 1.2)!
    expect(before.colors[1]).toBe(defaultSubtitleStyle.baseColor)
    expect(after.colors[0]).toBe(subtitleFrameAt([segment], [], 0.9)!.colors[0])
    expect(after.colors[0]).not.toBe(before.colors[0])
    const ass = generatePitchAss([segment], [])
    const firstMain = ass.split('\n').filter(line => line.startsWith('Dialogue: 0,0:00:00.00') && line.includes(',Main,'))
    expect(firstMain.some(line => line.includes(`\\c&H00FCFAF8&}好`))).toBe(true)
  })

  it('uses the model annotation rather than individual F0 samples for the sung glyph', () => {
    const segment = createSegment('唱你', 0, 2)
    const points = [
      { time: 0.1, hz: 220, confidence: 1, rms: 0.2, voiced: true },
      { time: 0.5, hz: 440, confidence: 1, rms: 0.2, voiced: true },
      { time: 0.9, hz: 660, confidence: 1, rms: 0.2, voiced: true },
    ]
    const beforeVoice = subtitleFrameAt([segment], points, 0.05)!
    const early = subtitleFrameAt([segment], points, 0.2)!
    const late = subtitleFrameAt([segment], points, 0.95)!
    const after = subtitleFrameAt([segment], points, 1.2)!
    expect(beforeVoice.colors[0]).toBe(defaultSubtitleStyle.baseColor)
    expect(beforeVoice.currentLabel).toBe('')
    const annotation = pitchForChar(segment.chars[0], points)
    expect(early.currentLabel).toBe(annotation.notes[0].note)
    expect(late.currentLabel).toBe(annotation.notes.at(-1)?.note)
    expect(after.colors[0]).toBe(late.colors[0])
    expect(after.colors[1]).toBe(defaultSubtitleStyle.baseColor)
    expect(generatePitchAss([segment], points).match(/,Main,/g)?.length).toBeGreaterThan(3)
  })

  it('never replaces a D4-C4 lyric annotation with a stray final B3 F0 sample', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'D4', start: 0, end: 0.45 },
      { note: 'C4', start: 0.45, end: 1 },
    ] }
    const points = [
      { time: 0.2, hz: 293.66, confidence: 1, rms: 0.2, voiced: true },
      { time: 0.7, hz: 261.63, confidence: 1, rms: 0.2, voiced: true },
      { time: 0.95, hz: 246.94, confidence: 0.3, rms: 0.2, voiced: true },
    ]
    expect(subtitleFrameAt([segment], points, 0.2)?.labels[0]).toBe('D4')
    expect(subtitleFrameAt([segment], points, 0.7)?.labels[0]).toBe('C4')
    const held = subtitleFrameAt([segment], points, 1.2)!
    expect(held.labels[0]).toBe('C4')
    expect(held.colors[0]).toBe(pitchColor(261.63, defaultSubtitleStyle))
    const ass = generatePitchAss([segment], points)
    expect(ass).toContain('0:00:01.00,0:00:02.00,Pitch')
    expect(ass).toMatch(/0:00:01\.00,0:00:02\.00,Pitch[^\n]*}C4/)
    expect(ass).not.toContain('}B3')
  })

  it('keeps a model-derived D4-C4 sequence despite one noisy B3 sample at the end', () => {
    const segment = createSegment('你好', 0, 2)
    const points = Array.from({ length: 50 }, (_, index) => ({
      time: 0.01 + index * 0.02,
      hz: index < 24 ? 293.66 : index < 49 ? 261.63 : 246.94,
      confidence: index === 49 ? 0.25 : 0.9, rms: 0.2, voiced: true,
    }))
    expect(pitchNotation(pitchForChar(segment.chars[0], points))).toBe('D4-C4')
    expect(wordTimedSubtitles([segment], points)[0].words[0].pitch?.notation).toBe('D4-C4')
    expect(subtitleFrameAt([segment], points, 0.3)?.labels[0]).toBe('D4')
    expect(subtitleFrameAt([segment], points, 0.8)?.labels[0]).toBe('C4')
    expect(subtitleFrameAt([segment], points, 1.2)?.labels[0]).toBe('C4')
    expect(generatePitchAss([segment], points)).not.toContain('}B3')
  })

  it('embeds optional raw F0 separately from the corrected lyric pitch with shared color band', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'D4', start: 0, end: 0.5 }, { note: 'C4', start: 0.5, end: 1 },
    ] }
    const points = [
      { time: 0.25, hz: 293.66, confidence: 1, rms: 0.2, voiced: true },
      { time: 0.75, hz: 261.63, confidence: 1, rms: 0.2, voiced: true },
      { time: 0.95, hz: 246.94, confidence: 0.3, rms: 0.2, voiced: true },
    ]
    expect(generatePitchAss([segment], points)).not.toContain(',RawPitch,,')
    const style = { ...defaultSubtitleStyle, embedRawPitch: true, rawPitchHorizontalPosition: 'left' as const, rawPitchVerticalPosition: 'bottom' as const, rawPitchFontSize: 64, rawPitchMargin: 72, colorBand: 'custom' as const }
    const ass = generatePitchAss([segment], points, style)
    const rawLines = ass.split('\n').filter(line => line.includes(',RawPitch,,'))
    const lyricLines = ass.split('\n').filter(line => line.includes(',Pitch,,'))
    expect(ass).toContain('Style: RawPitch,Microsoft YaHei,64,')
    expect(rawLines.some(line => line.includes('\\an1\\pos(72,1008)'))).toBe(true)
    expect(rawLines.some(line => line.includes(rawPitchLabel(points[2])))).toBe(true)
    const hex = pitchColor(points[2].hz, style).slice(1).toUpperCase()
    const assBgr = `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}&`
    expect(rawLines.some(line => line.includes(`\\c${assBgr}`) && line.includes('B3'))).toBe(true)
    expect(rawLines.some(line => line.includes('\\c&H') && line.includes('B3'))).toBe(true)
    expect(lyricLines.some(line => line.endsWith('}C4'))).toBe(true)
    expect(lyricLines.some(line => line.includes('B3'))).toBe(false)
    expect(rawPitchAt(points, 0.95)).toEqual(points[2])
  })

  it('reassigns model pitch after a lyric boundary moves, without moving the F0 timeline', () => {
    const segment = createSegment('你好', 0, 2)
    const points = Array.from({ length: 48 }, (_, index) => ({
      time: 0.02 + index * 0.02, hz: index < 24 ? 293.66 : 261.63,
      confidence: 0.9, rms: 0.2, voiced: true,
    }))
    const before = pitchNotation(pitchForChar(segment.chars[0], points))
    const moved = { ...segment, chars: segment.chars.map((char, index) => index === 0 ? { ...char, end: 0.46 } : { ...char, start: 0.46 }) }
    const after = pitchNotation(pitchForChar(moved.chars[0], points))
    expect(before).not.toBe(after)
    const retained = subtitleFrameAt([moved], points, 1.2)!.labels[0]
    expect(retained).toBe(pitchForChar(moved.chars[0], points).notes.at(-1)?.note)
    expect(wordTimedSubtitles([moved], points)[0].words[0].pitch?.notation).toBe(after)
    expect(generatePitchAss([moved], points)).toContain(`}${retained}`)
  })

  it('retains one selectable pitch label above every sung glyph in preview and ASS', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'C4', start: 0, end: 0.2 },
      { note: 'G4', start: 0.2, end: 0.8 },
      { note: 'E4', start: 0.8, end: 1 },
    ] }
    segment.chars[1].pitchOverride = { motion: 'flat', notes: [{ note: 'A4', start: 0, end: 1 }] }
    const cases = [
      { choice: 'last' as const, label: 'E4' },
      { choice: 'lowest' as const, label: 'C4' },
      { choice: 'highest' as const, label: 'G4' },
      { choice: 'longest' as const, label: 'G4' },
    ]
    const lastColor = subtitleFrameAt([segment], [], 1.2)!.colors[0]
    for (const { choice, label } of cases) {
      const frame = subtitleFrameAt([segment], [], 1.2, { retainedPitchLabel: choice })!
      expect(frame.labels).toEqual([label, 'A4'])
      expect(frame.colors[0]).toBe(lastColor)
      const ass = generatePitchAss([segment], [], { retainedPitchLabel: choice })
      const retained = ass.split('\n').find(line => line.startsWith('Dialogue: 1,0:00:01.00,0:00:02.00,Pitch') && line.endsWith(`}${label}`))
      expect(retained).toBeTruthy()
    }
    expect(subtitleFrameAt([segment], [], 1.2, { retainedPitchLabel: 'lowest' })!.labelColors[0]).not.toBe(lastColor)
    expect(generatePitchAss([segment], [], { showPitch: false })).not.toContain(',Pitch,,')
  })

  it('positions labels using actual lyric offsets, including spaces and wider Latin units', () => {
    const spaced = createSegment('你 A 好', 0, 3)
    const compact = createSegment('你A好', 0, 3)
    const spacedX = subtitleUnitCenterX(spaced, 2, defaultSubtitleStyle, null)
    const compactX = subtitleUnitCenterX(compact, 2, defaultSubtitleStyle, null)
    expect(spacedX).toBeGreaterThan(compactX)
    const ass = generatePitchAss([spaced], [], { horizontalPosition: 'left' })
    expect(ass).not.toContain('・')
  })

  it('uses the exact same ASS anchor for each glyph, its pitch label and its dot', () => {
    const segment = createSegment('你 A 好', 0, 3)
    for (const char of segment.chars) char.pitchOverride = { motion: 'flat', notes: [{ note: 'A4', start: 0, end: 1 }] }
    const lines = generatePitchAss([segment], [], { spacing: 2 }).split('\n')
    for (const [index, char] of segment.chars.entries()) {
      const time = `0:00:0${index}.00`
      const unit = lines.find(line => line.startsWith(`Dialogue: 0,${time},`) && line.includes(',Main,') && line.endsWith(`}${char.text}`))!
      const pitch = lines.find(line => line.startsWith(`Dialogue: 1,${time},`) && line.includes(',Pitch,'))!
      const dot = lines.find(line => line.startsWith(`Dialogue: 1,${time},`) && line.includes(',Dot,'))!
      const x = (line: string) => Number(/\\pos\((\d+),/.exec(line)?.[1])
      expect(x(unit)).toBeGreaterThan(0)
      expect(x(pitch)).toBe(x(unit))
      expect(x(dot)).toBe(x(unit))
    }
  })

  it('supports inclusive/exclusive per-note ranges, solid colors and linear gradients', () => {
    const style = { ...defaultSubtitleStyle, colorBand: 'ranges' as const, colorRules: recommendedPitchColorRules(), rangeFallback: 'base' as const }
    const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
    expect(pitchColor(hz(60), style)).toBe('#9CA3AF')
    expect(pitchColor(hz(63), style)).toBe('#9CA3AF')
    expect(pitchColor(hz(64), style)).toBe('#fde047')
    expect(pitchColor(hz(74), style)).toBe('#f43f5e')
    expect(pitchColor(hz(75), style)).toBe(style.baseColor)
    expect(pitchColor(hz(55), style)).not.toBe(pitchColor(hz(59), style))
  })

  it('detects the trusted F0 extremes for a project-specific recommendation', () => {
    const range = detectedPitchRange([
      { time: 0, hz: 130.81, confidence: 0.9, rms: 0.1, voiced: true },
      { time: 1, hz: 587.33, confidence: 0.9, rms: 0.1, voiced: true },
      { time: 2, hz: 1000, confidence: 0.1, rms: 0.1, voiced: true },
    ])!
    expect([range.minMidi, range.maxMidi, range.count]).toEqual([48, 74, 2])
    expect(recommendedPitchColorRules(range)[2].toMidi).toBe(74)
  })

  it('colors glyphs by pitch and shows the emphasis dot only under the active character', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'C4', start: 0, end: 0.5 },
      { note: 'C5', start: 0.5, end: 1 },
    ] }
    const style = { colorBand: 'custom' as const, lowColor: '#0000ff', highColor: '#ff0000', dotSize: 44, dotColorMode: 'custom' as const, dotColor: '#00ff00' }
    const early = subtitleFrameAt([segment], [], 0.2, style)!
    const late = subtitleFrameAt([segment], [], 0.7, style)!
    expect(early.colors[0]).not.toBe(late.colors[0])
    expect(early.activeIndex).toBe(0)
    expect(late.dotColor).toBe('#00ff00')
    const ass = generatePitchAss([segment], [], style)
    expect(ass).toContain('Style: Dot,Microsoft YaHei,44')
    expect(ass).toContain('\\c&H0000FF00&}m ')
  })

  it('exports the same manually edited pitch sequence and durations to JSON and ASS', () => {
    const segment = createSegment('唱', 1, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'E4', start: 0, end: 0.2 },
      { note: 'F4', start: 0.2, end: 0.7 },
      { note: 'E4', start: 0.7, end: 1 },
    ] }
    const json = wordTimedSubtitles([segment])[0].words[0]
    expect(json.pitch?.notation).toBe('E4-F4-E4')
    expect(json.pitch?.notes.map(note => [note.start, note.end])).toEqual([[1, 1.2], [1.2, 1.7], [1.7, 2]])
    const ass = generatePitchAss([segment], [])
    expect(ass).toContain('0:00:01.00,0:00:01.20,Pitch')
    expect(ass).toContain('0:00:01.20,0:00:01.70,Pitch')
    expect(ass).toContain('0:00:01.70,0:00:02.00,Pitch')
    expect(ass.match(/}E4\n/g)).toHaveLength(2)
    expect(ass.match(/}F4\n/g)).toHaveLength(1)
    const shifted = retimeSegment(segment, 2, 4)
    expect(wordTimedSubtitles([shifted])[0].words[0].pitch?.notes[0].end).toBe(2.4)
  })

  it('uses a single vibrato label rather than changing note on every pitch sample', () => {
    const segment = createSegment('唱', 0, 1)
    segment.chars[0].pitchOverride = { motion: 'vibrato', notes: [{ note: 'E4', start: 0, end: 1 }] }
    const ass = generatePitchAss([segment], [])
    expect(ass).toContain('}E4~')
    expect(ass.match(/,Pitch,/g)).toHaveLength(1)
  })

  it('exports broadly compatible sentence-level SRT timing', () => {
    const segment = createSegment('一句歌词', 1.234, 3.456)
    expect(sentenceSrt([segment])).toBe('1\n00:00:01,234 --> 00:00:03,456\n一句歌词\n')
  })

  it('places ASS captions in the selected grid position and supports a background box', () => {
    const segment = createSegment('歌词', 0, 1)
    const ass = generatePitchAss([segment], [], {
      verticalPosition: 'top', horizontalPosition: 'left', backgroundStyle: 'box',
      backgroundColor: '#000000', backgroundOpacity: 75, bold: false, italic: true,
    })
    expect(ass).toMatch(/Style: Main,[^\n]+,0,-1,0,0,100,100,0,0,1,/)
    expect(ass).toMatch(/,7,80,80,96,1/)
    expect(ass).toContain('&H40000000')
    expect(ass).toContain(',Back,')
  })
})
