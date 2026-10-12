import type { CharSpan, LyricSegment } from './lyrics'
import { MIN_SPAN, roundTime } from './lyrics'
import { noteHz, noteName, pitchForChar, validPitchAnnotation, type PitchAnnotation, type PitchPoint } from './pitch'

export type CharLink = { targetCharId: string; sourceCharIds: string[] }
export type LineLink = { targetLineId: string; sourceLineIds: string[]; charLinks: CharLink[]; confirmed?: boolean }
export type RepeatedSection = { id: string; family: string; lineIds: string[]; lineLinks: LineLink[] }
export type TransferOptions = { anchor: number; semitones: number; timing: boolean; pitch: boolean; preserveTargetManual: boolean; skipConflicts: boolean }
export type TransferRow = { targetLineId: string; before: [number, number]; after: [number, number]; issues: string[]; skipped: boolean }
export type TransferPreview = { segments: LyricSegment[]; rows: TransferRow[]; changes: number; issues: number; manualOverwrites: number }

export function orderedSections(sections: RepeatedSection[], segments: LyricSegment[]) {
  const positions = new Map(segments.map((line, index) => [line.id, index]))
  const counts = new Map<string, number>()
  return sections.filter(section => section.lineIds.some(id => positions.has(id)))
    .sort((a, b) => Math.min(...a.lineIds.map(id => positions.get(id) ?? Number.POSITIVE_INFINITY)) - Math.min(...b.lineIds.map(id => positions.get(id) ?? Number.POSITIVE_INFINITY)))
    .map(section => {
      const ordinal = (counts.get(section.family) ?? 0) + 1
      counts.set(section.family, ordinal)
      return { ...section, lineIds: section.lineIds.filter(id => positions.has(id)), ordinal, label: `${section.family}${ordinal}` }
    })
}

export function clearSectionMark(sections: RepeatedSection[], segments: LyricSegment[], id: string): RepeatedSection[] {
  const removed = orderedSections(sections, segments).find(section => section.id === id)
  if (!removed) return sections
  return sections.filter(section => section.id !== id).map(section =>
    removed.ordinal === 1 && section.family === removed.family ? { ...section, lineLinks: [] } : section)
}

export function contiguousLineIds(segments: LyricSegment[], selectedIds: string[]) {
  const selected = new Set(selectedIds)
  const indexes = segments.flatMap((line, index) => selected.has(line.id) ? [index] : [])
  return indexes.length === selected.size && indexes.length > 0 && indexes.at(-1)! - indexes[0] + 1 === indexes.length
    ? indexes.map(index => segments[index].id) : null
}

export function contiguousIds(order: string[], selectedIds: string[]) {
  const selected = new Set(selectedIds)
  const indexes = order.flatMap((id, index) => selected.has(id) ? [index] : [])
  return indexes.length === selected.size && indexes.length > 0 && indexes.at(-1)! - indexes[0] + 1 === indexes.length
    ? indexes.map(index => order[index]) : null
}

function proportionalRange(index: number, targetCount: number, sourceCount: number) {
  if (targetCount > sourceCount) {
    const matched = Math.round(index * (sourceCount - 1) / Math.max(1, targetCount - 1))
    return [matched, matched] as const
  }
  return [Math.floor(index * sourceCount / targetCount), Math.max(Math.floor((index + 1) * sourceCount / targetCount) - 1, Math.floor(index * sourceCount / targetCount))] as const
}

export function defaultLineLinks(source: RepeatedSection, target: RepeatedSection, segments: LyricSegment[]): LineLink[] {
  const lines = new Map(segments.map(line => [line.id, line]))
  const sourceLines = source.lineIds.filter(id => lines.has(id))
  const targetLines = target.lineIds.filter(id => lines.has(id))
  return targetLines.map((targetLineId, lineIndex) => {
    const [from, to] = proportionalRange(lineIndex, targetLines.length, sourceLines.length)
    const sourceLineIds = sourceLines.slice(from, to + 1)
    const sourceChars = sourceLineIds.flatMap(id => lines.get(id)?.chars ?? [])
    const targetChars = lines.get(targetLineId)?.chars ?? []
    return { targetLineId, sourceLineIds, charLinks: targetChars.map((char, charIndex) => {
      const [charFrom, charTo] = proportionalRange(charIndex, targetChars.length, sourceChars.length)
      return { targetCharId: char.id, sourceCharIds: sourceChars.slice(charFrom, charTo + 1).map(item => item.id) }
    }) }
  })
}

export function resolvedLineLinks(source: RepeatedSection, target: RepeatedSection, segments: LyricSegment[]): LineLink[] {
  const defaults = defaultLineLinks(source, target, segments)
  const sourceLineSet = new Set(source.lineIds)
  const sourceCharSet = new Set(source.lineIds.flatMap(id => segments.find(line => line.id === id)?.chars.map(char => char.id) ?? []))
  return defaults.map(fallback => {
    const existing = target.lineLinks.find(link => link.targetLineId === fallback.targetLineId)
    if (!existing) return fallback
    const sourceLineIds = existing.sourceLineIds.filter(id => sourceLineSet.has(id))
    if (!sourceLineIds.length && existing.sourceLineIds.length) return fallback
    return { ...fallback, sourceLineIds, confirmed: existing.confirmed, charLinks: fallback.charLinks.map(charFallback => {
      const charExisting = existing.charLinks.find(link => link.targetCharId === charFallback.targetCharId)
      if (!charExisting) return charFallback
      const sourceCharIds = charExisting.sourceCharIds.filter(id => sourceCharSet.has(id))
      return !sourceCharIds.length && charExisting.sourceCharIds.length ? charFallback : { ...charFallback, sourceCharIds }
    }) }
  })
}

function transpose(annotation: PitchAnnotation, semitones: number): PitchAnnotation {
  return { ...annotation, notes: annotation.notes.map(item => {
    const hz = noteHz(item.note)
    return { ...item, note: hz === null ? item.note : noteName(hz * 2 ** (semitones / 12)) }
  }) }
}

function mergedAnnotation(chars: CharSpan[], points: PitchPoint[], semitones: number): PitchAnnotation | null {
  if (!chars.length) return null
  const ordered = [...chars].sort((a, b) => a.start - b.start)
  if (ordered.every(char => !char.pitchOverride && !pitchForChar(char, points).notes.length)) return null
  if (ordered.length === 1) return transpose(pitchForChar(ordered[0], points), semitones)
  const start = ordered[0].start
  const end = Math.max(...ordered.map(char => char.end))
  const span = Math.max(0.001, end - start)
  const notes = ordered.flatMap(char => pitchForChar(char, points).notes.map(note => ({
    note: note.note,
    start: Math.max(0, Math.min(1, (char.start + (char.end - char.start) * note.start - start) / span)),
    end: Math.max(0, Math.min(1, (char.start + (char.end - char.start) * note.end - start) / span)),
  })))
  if (notes.length > 32) return null
  const boundaries = notes.slice(0, -1).map((item, index) => (item.end + notes[index + 1].start) / 2)
  const continuous = notes.map((item, index) => ({ note: item.note, start: index ? boundaries[index - 1] : 0, end: index === notes.length - 1 ? 1 : boundaries[index] }))
  const annotation: PitchAnnotation = { motion: continuous.length === 0 ? 'unvoiced' : continuous.length === 1 ? 'flat' : 'glide', notes: continuous }
  return validPitchAnnotation(annotation) ? transpose(annotation, semitones) : null
}

export function previewSectionTransfer(segments: LyricSegment[], points: PitchPoint[], source: RepeatedSection, target: RepeatedSection, options: TransferOptions, duration: number): TransferPreview {
  const byId = new Map(segments.map(line => [line.id, line]))
  const sourceLines = source.lineIds.map(id => byId.get(id)).filter((line): line is LyricSegment => !!line)
  const targetLines = target.lineIds.map(id => byId.get(id)).filter((line): line is LyricSegment => !!line)
  const sourceOrigin = sourceLines[0]?.start ?? 0
  const links = resolvedLineLinks(source, target, segments)
  const targetSet = new Set(targetLines.map(line => line.id))
  const external = segments.filter(line => !targetSet.has(line.id))
  const sourceChars = new Map(sourceLines.flatMap(line => line.chars.map(char => [char.id, char] as const)))
  const proposals = new Map<string, LyricSegment>()
  const rows: TransferRow[] = []
  let previousSourceLineIndex = -1
  for (const targetLine of targetLines) {
    const link = links.find(item => item.targetLineId === targetLine.id)
    const mapped = (link?.sourceLineIds ?? []).map(id => byId.get(id)).filter((line): line is LyricSegment => !!line && source.lineIds.includes(line.id))
    const issues: string[] = []
    if (!mapped.length) issues.push('尚未对应来源段的歌词句')
    if ((sourceLines.length !== targetLines.length || mapped.flatMap(line => line.chars).length !== targetLine.chars.length) && !link?.confirmed) issues.push('句数或字／词数不同，请核对并确认本句对应')
    if (link?.sourceLineIds.length && !contiguousIds(source.lineIds, link.sourceLineIds)) issues.push('来源歌词句必须连续，不能跳过中间句')
    const mappedLineIndexes = mapped.map(line => source.lineIds.indexOf(line.id))
    if (mappedLineIndexes.length && Math.min(...mappedLineIndexes) < previousSourceLineIndex) issues.push('逐句对应顺序交叉；请按歌词顺序连接')
    if (mappedLineIndexes.length) previousSourceLineIndex = Math.max(...mappedLineIndexes)
    const allowedCharOrder = mapped.flatMap(line => line.chars.map(char => char.id))
    const sourceIndexes = new Map(allowedCharOrder.map((id, index) => [id, index]))
    let previousSourceIndex = -1
    for (const char of targetLine.chars) {
      const mappedIds = link?.charLinks.find(item => item.targetCharId === char.id)?.sourceCharIds ?? []
      if (mappedIds.length && !contiguousIds(allowedCharOrder, mappedIds)) issues.push(`「${char.text}」对应的来源字／词必须连续`)
      const indexes = mappedIds.map(id => sourceIndexes.get(id)).filter((index): index is number => index !== undefined)
      if (indexes.length && Math.min(...indexes) < previousSourceIndex) issues.push('逐字对应顺序交叉；请按歌词顺序连接')
      if (indexes.length) previousSourceIndex = Math.max(...indexes)
    }
    const first = mapped[0]
    const last = mapped.at(-1)
    const sameLineLinks = links.filter(item => item.sourceLineIds.length && item.sourceLineIds.join('|') === link?.sourceLineIds.join('|'))
    const duplicateLineIndex = sameLineLinks.findIndex(item => item.targetLineId === targetLine.id)
    const lineFractionStart = duplicateLineIndex / Math.max(1, sameLineLinks.length)
    const lineFractionEnd = (duplicateLineIndex + 1) / Math.max(1, sameLineLinks.length)
    const mappedStart = first ? first.start + ((last?.end ?? first.end) - first.start) * lineFractionStart : targetLine.start
    const mappedEnd = first ? first.start + ((last?.end ?? first.end) - first.start) * lineFractionEnd : targetLine.end
    const proposedStart = first ? roundTime(options.anchor + mappedStart - sourceOrigin) : targetLine.start
    const proposedEnd = last ? roundTime(options.anchor + mappedEnd - sourceOrigin) : targetLine.end
    if (options.timing && (proposedStart < 0 || proposedEnd > duration || proposedEnd - proposedStart < MIN_SPAN)) issues.push('目标时间超出媒体范围或长度过短')
    if (options.timing && external.some(line => proposedStart < line.end - 0.001 && proposedEnd > line.start + 0.001)) issues.push('与未参与同步的歌词句重叠')
    if (options.timing && targetLine.chars.some(char => char.startLocked || char.endLocked)) issues.push('目标句含锁定的字边界')
    const sourceSpan = Math.max(0.001, (last?.end ?? 0) - (first?.start ?? 0))
    let chars = targetLine.chars.map(char => {
      const charLink = link?.charLinks.find(item => item.targetCharId === char.id)
      const matched = (charLink?.sourceCharIds ?? []).map(id => sourceChars.get(id)).filter((item): item is CharSpan => !!item)
      if (!matched.length) { issues.push(`「${char.text}」尚未对应来源字`); return char }
      const allowedChars = new Set(mapped.flatMap(item => item.chars.map(sourceChar => sourceChar.id)))
      if (matched.some(item => !allowedChars.has(item.id))) issues.push(`「${char.text}」对应的字不在所选来源句内`)
      const sameCharLinks = link?.charLinks.filter(item => item.sourceCharIds.length && item.sourceCharIds.join('|') === charLink?.sourceCharIds.join('|')) ?? []
      const duplicateCharIndex = sameCharLinks.findIndex(item => item.targetCharId === char.id)
      const rawFrom = Math.min(...matched.map(item => item.start))
      const rawTo = Math.max(...matched.map(item => item.end))
      const from = rawFrom + (rawTo - rawFrom) * duplicateCharIndex / Math.max(1, sameCharLinks.length)
      const to = rawFrom + (rawTo - rawFrom) * (duplicateCharIndex + 1) / Math.max(1, sameCharLinks.length)
      const nextStart = roundTime(proposedStart + (from - (first?.start ?? from)) / sourceSpan * (proposedEnd - proposedStart))
      const nextEnd = roundTime(proposedStart + (to - (first?.start ?? from)) / sourceSpan * (proposedEnd - proposedStart))
      if (options.timing && (nextStart < proposedStart - 0.001 || nextEnd > proposedEnd + 0.001 || nextEnd - nextStart < MIN_SPAN)) issues.push(`「${char.text}」的映射时间无效`)
      const shouldCopyPitch = options.pitch && (!options.preserveTargetManual || !char.pitchOverride)
      const manual = shouldCopyPitch ? mergedAnnotation(matched, points, options.semitones) : null
      if (shouldCopyPitch && !manual) issues.push(`「${char.text}」的来源音高尚未准备或无法转换`)
      return { ...char, ...(options.timing ? { start: nextStart, end: nextEnd, origin: 'manual' as const } : {}), ...(manual ? { pitchOverride: manual, pitchPreference: 'manual' as const } : {}) }
    })
    if (options.timing && chars.some((char, index) => index > 0 && char.start < chars[index - 1].end - 0.001)) issues.push('对应字之间发生重叠；请调整逐字对应关系')
    if (options.timing) chars = chars.map(char => ({ ...char, start: Math.max(proposedStart, char.start), end: Math.min(proposedEnd, char.end) }))
    const candidate = { ...targetLine, ...(options.timing ? { start: proposedStart, end: proposedEnd, timingSource: 'manual' as const } : {}), chars }
    proposals.set(targetLine.id, candidate)
    rows.push({ targetLineId: targetLine.id, before: [targetLine.start, targetLine.end], after: [candidate.start, candidate.end], issues: [...new Set(issues)], skipped: false })
  }
  if (options.timing) for (let index = 0; index < rows.length; index++) {
    for (let other = 0; other < rows.length; other++) {
      if (index === other) continue
      const a = rows[index].after
      const b = rows[other].after
      if (a[0] < b[1] - 0.001 && a[1] > b[0] + 0.001) { rows[index].issues.push('与另一条待同步歌词句重叠'); break }
    }
  }
  if (options.timing && options.skipConflicts) {
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (row.issues.length) continue
        if (rows.some(other => other !== row && other.issues.length && row.after[0] < other.before[1] - 0.001 && row.after[1] > other.before[0] + 0.001)) {
          row.issues.push('与跳过同步的原歌词句重叠')
          changed = true
        }
      }
    }
  }
  const blocked = rows.some(row => row.issues.length)
  const next = segments.map(line => {
    const candidate = proposals.get(line.id)
    const row = rows.find(item => item.targetLineId === line.id)
    if (!candidate || !row) return line
    if ((!options.skipConflicts && blocked) || (options.skipConflicts && row.issues.length)) {
      row.skipped = true
      return line
    }
    return JSON.stringify(candidate) === JSON.stringify(line) ? line : candidate
  })
  const manualOverwrites = next.reduce((count, line, index) => count + line.chars.filter((char, charIndex) => segments[index].chars[charIndex]?.pitchOverride && char.pitchOverride !== segments[index].chars[charIndex].pitchOverride).length, 0)
  return { segments: next, rows, changes: next.filter((line, index) => line !== segments[index]).length, issues: rows.filter(row => row.issues.length).length, manualOverwrites }
}
