import type { AcousticAnalysis, AcousticCandidate } from './acoustics'
import { MIN_SPAN, roundTime, type CharSpan, type LyricSegment } from './lyrics'
import type { PitchPoint } from './pitch'

export type BoundaryReview = { charId: string; score: number; reasons: string[]; nearestCandidate?: AcousticCandidate }

export function nearestCandidate(candidates: AcousticCandidate[], time: number, radius = 0.2): AcousticCandidate | undefined {
  let low = 0
  let high = candidates.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (candidates[middle].time < time) low = middle + 1
    else high = middle
  }
  const nearby = [candidates[low - 1], candidates[low], candidates[low + 1]].filter((item): item is AcousticCandidate => !!item && Math.abs(item.time - time) <= radius)
  return nearby.sort((a, b) => (Math.abs(a.time - time) / Math.max(0.2, a.strength)) - (Math.abs(b.time - time) / Math.max(0.2, b.strength)))[0]
}

export function snapAcousticBoundary(time: number, candidates: AcousticCandidate[], pixelsPerSecond: number, disabled = false): AcousticCandidate | undefined {
  if (disabled) return undefined
  const radius = Math.min(0.15, 12 / Math.max(1, pixelsPerSecond))
  const candidate = nearestCandidate(candidates, time, radius)
  return candidate?.strength && candidate.strength >= 0.25 ? candidate : undefined
}

function pitchWithin(points: PitchPoint[], start: number, end: number): PitchPoint[] {
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (points[middle].time < start) low = middle + 1
    else high = middle
  }
  const result: PitchPoint[] = []
  for (let index = low; index < points.length && points[index].time < end; index++) result.push(points[index])
  return result
}

export function scoreCharTiming(segment: LyricSegment, char: CharSpan, analysis: AcousticAnalysis | null, points: PitchPoint[], lowConfidenceLine = false, vocalPeak = 1): BoundaryReview {
  let score = 0
  const reasons: string[] = []
  const duration = char.end - char.start
  const lexical = /[\p{Script=Han}A-Za-z]/u.test(char.text)
  if (!lexical) return { charId: char.id, score: 0, reasons: [] }
  const neighbors = segment.chars.filter(item => item.text && item.end - item.start >= 0.08 && item.end - item.start <= 2.5).map(item => item.end - item.start).sort((a, b) => a - b)
  const typical = neighbors.length ? neighbors[Math.floor(neighbors.length / 2)] : 0.3
  const source = char.timingEvidence?.source
  if (source === 'interpolated') { score += 27; reasons.push('此字时间由邻近识别点插值') }
  if (source === 'lrc') { score += 22; reasons.push('主要依赖句级 LRC 时间') }
  if (!source && char.origin !== 'manual') { score += 18; reasons.push('缺少直接逐字识别证据') }
  const probability = char.timingEvidence?.asrProbability
  if (probability !== undefined && probability < 0.55) { score += Math.round((0.55 - probability) * 40); reasons.push('语音识别把握较低') }
  if (lowConfidenceLine) { score += 15; reasons.push('所属句缺少可靠识别锚点') }
  if (duration < 0.08 && /[\p{Script=Han}A-Za-z]/u.test(char.text)) { score += 32; reasons.push('字时长过短') }
  else if (duration < typical * 0.35 && duration < 0.15) { score += 16; reasons.push('明显短于本句其他字') }
  const insidePitch = pitchWithin(points, char.start, char.end)
  const voiced = insidePitch.filter(point => point.voiced && point.confidence >= 0.25)
  if (duration > Math.max(1.6, typical * 4) && voiced.length < 4) { score += 12; reasons.push('时长偏长且缺少持续音高') }
  if (duration >= 0.35 && insidePitch.length >= 6 && voiced.length >= 3 && voiced.reduce((sum, point) => sum + point.confidence, 0) / voiced.length < 0.4) { score += 8; reasons.push('这段音高识别置信度较低，仅作为辅助线索') }
  let candidate: AcousticCandidate | undefined
  if (analysis) {
    candidate = nearestCandidate(analysis.candidates, char.start, 0.25)
    if (!candidate || Math.abs(candidate.time - char.start) > 0.14) { score += 13; reasons.push('字起点附近缺少明显声学变化') }
    const from = Math.max(0, Math.floor(char.start / analysis.step))
    const to = Math.min(analysis.rms.length, Math.ceil(Math.min(char.end, char.start + 0.16) / analysis.step))
    const region = analysis.rms.slice(from, to)
    const peak = Math.max(...region, 0)
    if (peak < vocalPeak * 0.025 && duration >= 0.12) { score += 16; reasons.push('字开始后的人声能量很低') }
    if (duration >= 0.4) {
      const fullEnd = Math.min(analysis.rms.length, Math.ceil(char.end / analysis.step))
      let silentFrames = 0
      let longestSilence = 0
      for (let index = from; index < fullEnd; index++) {
        silentFrames = analysis.rms[index] < vocalPeak * 0.025 ? silentFrames + 1 : 0
        longestSilence = Math.max(longestSilence, silentFrames)
      }
      if (longestSilence * analysis.step >= 0.16) { score += 12; reasons.push('一个字的范围内包含较长静音') }
    }
  }
  if (char.origin === 'manual' || char.startLocked || char.endLocked) score = Math.max(0, score - 22)
  return { charId: char.id, score: Math.min(100, score), reasons, nearestCandidate: candidate }
}

/** Reuse a stored alignment suggestion inside a sentence while keeping confirmed edges fixed. */
export function reapplyUnlockedLine(current: LyricSegment, suggestion: LyricSegment): LyricSegment | null {
  if (current.chars.length !== suggestion.chars.length || current.chars.some((char, index) => char.id !== suggestion.chars[index].id || char.text !== suggestion.chars[index].text)) return null
  const original: number[] = []
  const target: number[] = []
  const locked: number[] = []
  for (let index = 0; index < current.chars.length; index++) {
    const char = current.chars[index]
    const advised = suggestion.chars[index]
    original.push(advised.start, advised.end)
    target.push(advised.start, advised.end)
    if (char.startLocked) { locked.push(index * 2); target[index * 2] = char.start }
    if (char.endLocked) { locked.push(index * 2 + 1); target[index * 2 + 1] = char.end }
  }
  const anchors = [-1, ...locked.sort((a, b) => a - b), target.length]
  const anchorSource = (index: number) => index < 0 ? suggestion.start : index >= original.length ? suggestion.end : original[index]
  const anchorTarget = (index: number) => index < 0 ? current.start : index >= target.length ? current.end : target[index]
  for (let interval = 0; interval < anchors.length - 1; interval++) {
    const left = anchors[interval]
    const right = anchors[interval + 1]
    const sourceSpan = anchorSource(right) - anchorSource(left)
    const targetSpan = anchorTarget(right) - anchorTarget(left)
    if (targetSpan < 0) return null
    for (let index = left + 1; index < right; index++) {
      const ratio = sourceSpan > 0.001 ? (original[index] - anchorSource(left)) / sourceSpan : (index - left) / (right - left)
      target[index] = roundTime(anchorTarget(left) + Math.min(1, Math.max(0, ratio)) * targetSpan)
    }
  }
  const chars = current.chars.map((char, index) => ({
    ...char,
    start: target[index * 2], end: target[index * 2 + 1],
    timingEvidence: suggestion.chars[index].timingEvidence,
    origin: char.startLocked && char.endLocked ? char.origin : 'estimated' as const,
  }))
  if (chars.some((char, index) => char.start < current.start - 0.001 || char.end > current.end + 0.001 || (/[\p{Script=Han}A-Za-z]/u.test(char.text) && char.end - char.start < MIN_SPAN - 0.001) || (index > 0 && char.start < chars[index - 1].end - 0.001))) return null
  return { ...current, chars }
}

/** Applying any stored/new alignment must never silently move a confirmed boundary. */
export function mergeAlignmentKeepingLocks(suggestions: LyricSegment[], current: LyricSegment[]): LyricSegment[] {
  const byId = new Map(current.map(line => [line.id, line]))
  return suggestions.map(suggestion => {
    const previous = byId.get(suggestion.id)
    if (!previous?.chars.some(char => char.startLocked || char.endLocked)) return suggestion
    return reapplyUnlockedLine(previous, suggestion) ?? previous
  })
}
