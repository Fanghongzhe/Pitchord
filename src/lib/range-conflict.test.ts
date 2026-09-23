import { describe, expect, it } from 'vitest'
import { resolveRangeConflict } from './range-conflict'

const clips = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1, end: 2 }, { id: 'c', start: 2, end: 3 }]

describe('range adjustment conflicts', () => {
  it('compresses neighbors and propagates a minimum span within the owning line', () => {
    const result = resolveRangeConflict(clips, { id: 'b', start: 0.04, end: 2.96 }, { start: 0, end: 3 }, 'compress')!
    expect(result).toEqual([{ id: 'a', start: 0, end: 0.04 }, { id: 'b', start: 0.04, end: 2.96 }, { id: 'c', start: 2.96, end: 3 }])
  })

  it('preserves neighbor lengths when pushing fits, and rejects it at the sentence boundary', () => {
    const roomy = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1.5, end: 2.5 }, { id: 'c', start: 3, end: 4 }]
    expect(resolveRangeConflict(roomy, { id: 'b', start: 0.5, end: 3.5 }, { start: 0, end: 5 }, 'push')).toBeNull()
    expect(resolveRangeConflict(roomy, { id: 'b', start: 1.2, end: 2.8 }, { start: 0, end: 5 }, 'push')).toEqual([
      { id: 'a', start: 0, end: 1 }, { id: 'b', start: 1.2, end: 2.8 }, { id: 'c', start: 3, end: 4 },
    ])
    expect(resolveRangeConflict(roomy, { id: 'b', start: 0.8, end: 3.2 }, { start: -1, end: 5 }, 'push')).toEqual([
      { id: 'a', start: -0.2, end: 0.8 }, { id: 'b', start: 0.8, end: 3.2 }, { id: 'c', start: 3.2, end: 4.2 },
    ])
  })
})
