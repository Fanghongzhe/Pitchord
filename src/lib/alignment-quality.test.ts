import { describe, expect, it } from 'vitest'
import { createSegment } from './lyrics'
import { mergeAlignmentKeepingLocks, reapplyUnlockedLine, scoreCharTiming, snapAcousticBoundary } from './alignment-quality'

describe('alignment review and confirmed anchors', () => {
  it('only snaps to a nearby acoustic proposal and permits Alt/manual bypass', () => {
    const candidates = [{ time: 1.24, strength: 0.8, kind: 'spectrum' as const, reason: '频谱变化' }]
    expect(snapAcousticBoundary(1.28, candidates, 100)?.time).toBe(1.24)
    expect(snapAcousticBoundary(1.28, candidates, 100, true)).toBeUndefined()
    expect(snapAcousticBoundary(1.4, candidates, 100)).toBeUndefined()
  })

  it('scores interpolation as review evidence without treating every pitch change as a boundary', () => {
    const line = createSegment('你好', 0, 1)
    line.chars[0].timingEvidence = { source: 'interpolated', matched: false }
    const review = scoreCharTiming(line, line.chars[0], null, [], false)
    expect(review.score).toBeGreaterThanOrEqual(27)
    expect(review.reasons).toContain('此字时间由邻近识别点插值')
    const punctuation = createSegment('，', 0, 0.02)
    expect(scoreCharTiming(punctuation, punctuation.chars[0], null, [], false).score).toBe(0)
  })

  it('locally reapplies advice while preserving a shared confirmed boundary', () => {
    const current = createSegment('你好世界', 0, 4)
    current.chars[1].end = 2.2
    current.chars[1].endLocked = true
    current.chars[2].start = 2.2
    current.chars[2].startLocked = true
    const suggestion = { ...current, chars: current.chars.map((char, index) => ({ ...char, start: index * 0.95, end: (index + 1) * 0.95 })) }
    const result = reapplyUnlockedLine(current, suggestion)
    expect(result).not.toBeNull()
    expect(result?.chars[1].end).toBe(2.2)
    expect(result?.chars[2].start).toBe(2.2)
    expect(result?.chars[0].end).not.toBe(current.chars[0].end)
    expect(result?.chars.every((char, index) => index === 0 || char.start >= result.chars[index - 1].end)).toBe(true)
    expect(mergeAlignmentKeepingLocks([suggestion], [current])[0].chars[1].end).toBe(2.2)
  })

  it('retains the current sentence if a stored suggestion cannot respect anchors', () => {
    const current = createSegment('你好', 0, 2)
    current.chars[0].endLocked = true
    const incompatible = { ...current, chars: current.chars.slice(0, 1) }
    expect(mergeAlignmentKeepingLocks([incompatible], [current])[0]).toBe(current)
  })
})
