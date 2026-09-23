import { MIN_SPAN, roundTime } from './lyrics'

export type TimeRange = { id: string; start: number; end: number }

export function resolveRangeConflict(clips: TimeRange[], target: TimeRange, bounds: { start: number; end: number }, strategy: 'compress' | 'push'): TimeRange[] | null {
  const index = clips.findIndex(clip => clip.id === target.id)
  if (index < 0 || target.start < bounds.start || target.end > bounds.end || target.end - target.start < MIN_SPAN) return null
  const result = clips.map(clip => ({ ...clip }))
  result[index] = { ...target }

  for (let i = index - 1; i >= 0; i--) {
    const current = result[i]
    const next = result[i + 1]
    if (current.end <= next.start) continue
    if (strategy === 'push') {
      const shift = current.end - next.start
      current.start -= shift
      current.end -= shift
    } else {
      current.end = next.start
      current.start = Math.min(current.start, current.end - MIN_SPAN)
    }
  }
  for (let i = index + 1; i < result.length; i++) {
    const previous = result[i - 1]
    const current = result[i]
    if (current.start >= previous.end) continue
    if (strategy === 'push') {
      const shift = previous.end - current.start
      current.start += shift
      current.end += shift
    } else {
      current.start = previous.end
      current.end = Math.max(current.end, current.start + MIN_SPAN)
    }
  }
  const rounded = result.map(clip => ({ id: clip.id, start: roundTime(clip.start), end: roundTime(clip.end) }))
  if (rounded[0].start < bounds.start - 0.0005 || rounded.at(-1)!.end > bounds.end + 0.0005 ||
      rounded.some((clip, i) => clip.end - clip.start < MIN_SPAN - 0.0005 || (i > 0 && clip.start < rounded[i - 1].end - 0.0005))) return null
  return rounded
}
