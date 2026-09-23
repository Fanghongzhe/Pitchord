import { describe, expect, it } from 'vitest'
import { createSegment, getAdjacentSelection, mergeSegments, parseLyrics, replaceText, retimeSegment, splitSegment } from './lyrics'

describe('lyric editing invariants', () => {
  it('imports timed LRC, skips metadata, and keeps lines in time order', () => {
    const lines = parseLyrics('[ar:歌手]\n[00:04.00]第二句\n[00:00.50]第一句', 8)
    expect(lines.map(line => line.text)).toEqual(['第一句', '第二句'])
    expect(lines[0].end).toBeLessThan(lines[1].start)
    expect(lines.every(line => line.chars.every(char => char.start >= line.start && char.end <= line.end))).toBe(true)
  })

  it('merges only consecutive selections and carries text, time and character offsets', () => {
    const lines = [createSegment('你好', 0, 2), createSegment('世界', 2, 4), createSegment('再见', 5, 7)]
    expect(getAdjacentSelection(lines, [lines[0].id, lines[2].id])).toBeNull()
    const indexes = getAdjacentSelection(lines, [lines[1].id, lines[0].id])
    expect(indexes).toEqual([0, 1])
    const merged = mergeSegments(indexes!.map(index => lines[index]))!
    expect(merged.text).toBe('你好 世界')
    expect([merged.start, merged.end]).toEqual([0, 4])
    expect(merged.chars.map(char => char.startOffset)).toEqual([0, 1, 3, 4])
  })

  it('splits time and text together and keeps every child inside its new line', () => {
    const original = createSegment('今天我唱', 1, 5)
    const [left, right] = splitSegment(original, 2.5, 2)!
    expect([left.text, right.text]).toEqual(['今天', '我唱'])
    expect([left.start, left.end, right.start, right.end]).toEqual([1, 2.5, 2.5, 5])
    expect(left.chars.every(char => char.start >= left.start && char.end <= left.end)).toBe(true)
    expect(right.chars.every(char => char.start >= right.start && char.end <= right.end)).toBe(true)
    expect(splitSegment(original, 5, 2)).toBeNull()
  })

  it('moves the character times with a retimed line', () => {
    const original = createSegment('两个字', 0, 3)
    const moved = retimeSegment(original, 5, 8)
    expect(moved.chars.map(char => [char.start, char.end])).toEqual([[5, 6], [6, 7], [7, 8]])
  })

  it('preserves unchanged character timing around a text insertion', () => {
    const original = createSegment('你好', 0, 2)
    const changed = replaceText(original, '你们好')
    expect(changed.chars.map(char => char.text)).toEqual(['你', '们', '好'])
    expect(changed.chars[0].id).toBe(original.chars[0].id)
    expect(changed.chars[2].id).toBe(original.chars[1].id)
    expect(changed.chars[1].origin).toBe('estimated')
  })
})
