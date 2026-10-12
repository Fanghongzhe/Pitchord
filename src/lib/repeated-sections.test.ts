import { describe, expect, it } from 'vitest'
import { createSegment } from './lyrics'
import { pitchForChar, pitchNotation, validPitchAnnotation } from './pitch'
import { clearSectionMark, contiguousIds, contiguousLineIds, defaultLineLinks, orderedSections, previewSectionTransfer, type RepeatedSection } from './repeated-sections'

function fixture() {
  const lines = [createSegment('春风', 0, 2), createSegment('夜雨', 2.2, 4.2), createSegment('春风', 10, 12), createSegment('夜雨', 12.2, 14.2)]
  lines[0].chars[0].pitchOverride = { motion: 'glide', notes: [{ note: 'D4', start: 0, end: 0.5 }, { note: 'C4', start: 0.5, end: 1 }] }
  lines[0].chars[1].pitchOverride = { motion: 'flat', notes: [{ note: 'E4', start: 0, end: 1 }] }
  for (const char of lines[1].chars) char.pitchOverride = { motion: 'flat', notes: [{ note: 'A3', start: 0, end: 1 }] }
  const source: RepeatedSection = { id: 'a1', family: 'A', lineIds: lines.slice(0, 2).map(line => line.id), lineLinks: [] }
  const target: RepeatedSection = { id: 'a2', family: 'A', lineIds: lines.slice(2).map(line => line.id), lineLinks: [] }
  const options = { anchor: 11, semitones: 2, timing: true, pitch: true, preserveTargetManual: true, skipConflicts: false }
  return { lines, source, target, options }
}

describe('repeated sections', () => {
  it('accepts only an uninterrupted selection and numbers instances in lyric order', () => {
    const { lines, source, target } = fixture()
    expect(contiguousLineIds(lines, [lines[0].id, lines[1].id])).toEqual(source.lineIds)
    expect(contiguousLineIds(lines, [lines[0].id, lines[2].id])).toBeNull()
    expect(orderedSections([target, source], lines).map(item => item.label)).toEqual(['A1', 'A2'])
    expect(contiguousIds(['a', 'b', 'c'], ['a', 'c'])).toBeNull()
    expect(contiguousIds(['a', 'b', 'c'], ['c', 'b'])).toEqual(['b', 'c'])
  })

  it('clears one mark, renumbers later instances, and resets mappings only when their source changes', () => {
    const { lines, source, target } = fixture()
    const laterLine = createSegment('春风', 20, 22)
    const allLines = [...lines, laterLine]
    const third: RepeatedSection = { id: 'a3', family: 'A', lineIds: [laterLine.id], lineLinks: [{ targetLineId: laterLine.id, sourceLineIds: [lines[0].id], charLinks: [] }] }
    const linkedTarget = { ...target, lineLinks: [{ targetLineId: lines[2].id, sourceLineIds: [lines[0].id], charLinks: [] }] }
    const remaining = clearSectionMark([source, linkedTarget, third], allLines, source.id)
    expect(orderedSections(remaining, allLines).map(section => section.label)).toEqual(['A1', 'A2'])
    expect(remaining.every(section => section.lineLinks.length === 0)).toBe(true)
    expect(clearSectionMark([source, linkedTarget, third], allLines, linkedTarget.id).find(section => section.id === third.id)?.lineLinks).toEqual(third.lineLinks)
  })

  it('treats English words as visual mapping units and suggests contiguous many-to-one links', () => {
    const source = createSegment('wo yeah Wu', 0, 3)
    const target = createSegment('喔耶', 10, 12)
    const sourceSection: RepeatedSection = { id: 'a1', family: 'A', lineIds: [source.id], lineLinks: [] }
    const targetSection: RepeatedSection = { id: 'a2', family: 'A', lineIds: [target.id], lineLinks: [] }
    expect(source.chars.map(char => char.text)).toEqual(['wo', 'yeah', 'Wu'])
    const links = defaultLineLinks(sourceSection, targetSection, [source, target])[0].charLinks
    expect(links.map(link => link.sourceCharIds.length)).toEqual([1, 2])
    expect(links[1].sourceCharIds).toEqual(source.chars.slice(1).map(char => char.id))
    const proposed = previewSectionTransfer([source, target], [], sourceSection, targetSection, { anchor: 10, semitones: 0, timing: true, pitch: false, preserveTargetManual: true, skipConflicts: false }, 20)
    expect(proposed.rows[0].issues).toContain('句数或字／词数不同，请核对并确认本句对应')
    const reverse = defaultLineLinks(targetSection, sourceSection, [source, target])[0].charLinks
    expect(reverse.map(link => link.sourceCharIds[0])).toEqual([target.chars[0].id, target.chars[1].id, target.chars[1].id])
  })

  it('blocks skipped and reversed source ranges before syncing', () => {
    const source = createSegment('春风雨', 0, 3)
    const target = createSegment('春风', 10, 12)
    const sourceSection: RepeatedSection = { id: 'a1', family: 'A', lineIds: [source.id], lineLinks: [] }
    const links = defaultLineLinks(sourceSection, { id: 'a2', family: 'A', lineIds: [target.id], lineLinks: [] }, [source, target])
    links[0].confirmed = true
    links[0].charLinks[0].sourceCharIds = [source.chars[0].id, source.chars[2].id]
    let preview = previewSectionTransfer([source, target], [], sourceSection, { id: 'a2', family: 'A', lineIds: [target.id], lineLinks: links }, { anchor: 10, semitones: 0, timing: true, pitch: false, preserveTargetManual: true, skipConflicts: false }, 20)
    expect(preview.rows[0].issues.some(issue => issue.includes('必须连续'))).toBe(true)
    expect(preview.changes).toBe(0)
    links[0].charLinks[0].sourceCharIds = [source.chars[2].id]
    links[0].charLinks[1].sourceCharIds = [source.chars[0].id]
    preview = previewSectionTransfer([source, target], [], sourceSection, { id: 'a2', family: 'A', lineIds: [target.id], lineLinks: links }, { anchor: 10, semitones: 0, timing: true, pitch: false, preserveTargetManual: true, skipConflicts: false }, 20)
    expect(preview.rows[0].issues).toContain('逐字对应顺序交叉；请按歌词顺序连接')
    expect(preview.changes).toBe(0)
  })

  it('rejects line links that reverse the order of repeated lyrics', () => {
    const { lines, source, target, options } = fixture()
    const links = defaultLineLinks(source, target, lines)
    links[0].sourceLineIds = [source.lineIds[1]]
    links[1].sourceLineIds = [source.lineIds[0]]
    const preview = previewSectionTransfer(lines, [], source, { ...target, lineLinks: links }, options, 20)
    expect(preview.rows[1].issues).toContain('逐句对应顺序交叉；请按歌词顺序连接')
    expect(preview.changes).toBe(0)
  })

  it('copies sentence and character timing from a confirmed first-line anchor, transposing manual pitch', () => {
    const { lines, source, target, options } = fixture()
    const preview = previewSectionTransfer(lines, [], source, target, options, 20)
    expect(preview.issues).toBe(0)
    expect(preview.changes).toBe(2)
    expect(preview.segments[2].start).toBe(11)
    expect(preview.segments[2].end).toBe(13)
    expect(preview.segments[3].start).toBe(13.2)
    expect(preview.segments[2].chars[0].end).toBe(12)
    expect(pitchNotation(preview.segments[2].chars[0].pitchOverride!)).toBe('E4-D4')
    expect(preview.segments[2].chars[0].pitchPreference).toBe('manual')
    expect(lines[2].start).toBe(10)
  })

  it('supports different line and character counts by splitting repeated mappings', () => {
    const source = createSegment('春风', 0, 2)
    const targets = [createSegment('春风起', 10, 11), createSegment('又春风', 11, 12)]
    const lines = [source, ...targets]
    const a1: RepeatedSection = { id: 'a1', family: 'A', lineIds: [source.id], lineLinks: [] }
    const a2: RepeatedSection = { id: 'a2', family: 'A', lineIds: targets.map(line => line.id), lineLinks: [] }
    expect(defaultLineLinks(a1, a2, lines).map(link => link.sourceLineIds)).toEqual([[source.id], [source.id]])
    const proposed = previewSectionTransfer(lines, [], a1, a2, { anchor: 10, semitones: 0, timing: true, pitch: false, preserveTargetManual: true, skipConflicts: false }, 20)
    expect(proposed.issues).toBe(2)
    const confirmed = { ...a2, lineLinks: defaultLineLinks(a1, a2, lines).map(link => ({ ...link, confirmed: true })) }
    const preview = previewSectionTransfer(lines, [], a1, confirmed, { anchor: 10, semitones: 0, timing: true, pitch: false, preserveTargetManual: true, skipConflicts: false }, 20)
    expect(preview.issues).toBe(0)
    expect(preview.segments[1].end).toBe(11)
    expect(preview.segments[2].start).toBe(11)
    for (const line of preview.segments.slice(1)) for (let index = 1; index < line.chars.length; index++) expect(line.chars[index].start).toBeGreaterThanOrEqual(line.chars[index - 1].end)
  })

  it('combines multiple source characters into one valid editable pitch sequence', () => {
    const source = createSegment('春风', 0, 2)
    source.chars[0].pitchOverride = { motion: 'flat', notes: [{ note: 'C4', start: 0, end: 1 }] }
    source.chars[1].pitchOverride = { motion: 'flat', notes: [{ note: 'E4', start: 0, end: 1 }] }
    const target = createSegment('春', 10, 12)
    const a1: RepeatedSection = { id: 'a1', family: 'A', lineIds: [source.id], lineLinks: [] }
    const a2: RepeatedSection = { id: 'a2', family: 'A', lineIds: [target.id], lineLinks: [] }
    const preview = previewSectionTransfer([source, target], [], a1, { ...a2, lineLinks: defaultLineLinks(a1, a2, [source, target]).map(link => ({ ...link, confirmed: true })) }, { anchor: 10, semitones: 0, timing: true, pitch: true, preserveTargetManual: false, skipConflicts: false }, 20)
    expect(preview.issues).toBe(0)
    expect(pitchNotation(preview.segments[1].chars[0].pitchOverride!)).toBe('C4-E4')
    expect(validPitchAnnotation(preview.segments[1].chars[0].pitchOverride)).toBe(true)
  })

  it('does not fabricate a manual unvoiced result before source pitch analysis', () => {
    const source = createSegment('春', 0, 1)
    const target = createSegment('春', 10, 11)
    const a1: RepeatedSection = { id: 'a1', family: 'A', lineIds: [source.id], lineLinks: [] }
    const a2: RepeatedSection = { id: 'a2', family: 'A', lineIds: [target.id], lineLinks: [] }
    const preview = previewSectionTransfer([source, target], [], a1, a2, { anchor: 10, semitones: 0, timing: true, pitch: true, preserveTargetManual: true, skipConflicts: false }, 20)
    expect(preview.issues).toBe(1)
    expect(preview.changes).toBe(0)
    expect(target.chars[0].pitchOverride).toBeUndefined()
    const unrelated = [{ time: 8, hz: 440, confidence: 0.9, rms: 0.2, voiced: true }]
    expect(previewSectionTransfer([source, target], unrelated, a1, a2, { anchor: 10, semitones: 0, timing: false, pitch: true, preserveTargetManual: true, skipConflicts: false }, 20).issues).toBe(1)
  })

  it('shows conflicts before applying and can skip only conflicting target lines', () => {
    const { lines, source, target, options } = fixture()
    const obstacle = createSegment('间奏', 11.5, 12.5)
    const blocked = previewSectionTransfer([...lines, obstacle], [], source, target, options, 20)
    expect(blocked.issues).toBe(1)
    expect(blocked.changes).toBe(0)
    const skipped = previewSectionTransfer([...lines, obstacle], [], source, target, { ...options, skipConflicts: true }, 20)
    expect(skipped.changes).toBe(1)
    expect(skipped.rows[0].skipped).toBe(true)
  })

  it('protects locked target boundaries and reports missing correspondences', () => {
    const { lines, source, target, options } = fixture()
    lines[2].chars[0].startLocked = true
    const locked = previewSectionTransfer(lines, [], source, target, options, 20)
    expect(locked.rows[0].issues).toContain('目标句含锁定的字边界')
    expect(locked.changes).toBe(0)
    const links = defaultLineLinks(source, target, lines)
    links[0].charLinks[0].sourceCharIds = []
    const missing = previewSectionTransfer(lines, [], source, { ...target, lineLinks: links }, { ...options, timing: false }, 20)
    expect(missing.rows[0].issues.some(issue => issue.includes('尚未对应来源字'))).toBe(true)
  })

  it('preserves a target manual result and lets the model remain selectable without discarding it', () => {
    const { lines, source, target, options } = fixture()
    const manual = { motion: 'flat' as const, notes: [{ note: 'G4', start: 0, end: 1 }] }
    lines[2].chars[0].pitchOverride = manual
    const preview = previewSectionTransfer(lines, [], source, target, options, 20)
    expect(preview.segments[2].chars[0].pitchOverride).toBe(manual)
    const modelFirst = { ...preview.segments[2].chars[0], pitchPreference: 'model' as const }
    expect(modelFirst.pitchOverride).toBe(manual)
    expect(pitchForChar(modelFirst, []).notes).toEqual([])
    expect(pitchForChar({ ...modelFirst, pitchPreference: 'manual' }, [])).toBe(manual)
  })
})
