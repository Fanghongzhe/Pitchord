import type { AcousticAnalysis, AcousticCandidate } from './acoustics'

const size = 512
const bands = 48
const hop = 160 // 20 ms at 8 kHz
const bitReverse = Array.from({ length: size }, (_, index) => Number.parseInt(index.toString(2).padStart(9, '0').split('').reverse().join(''), 2))

function fftMagnitude(input: Float32Array): Float32Array {
  const real = new Float32Array(size)
  const imaginary = new Float32Array(size)
  for (let index = 0; index < size; index++) {
    real[bitReverse[index]] = input[index] * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (size - 1)))
  }
  for (let length = 2; length <= size; length *= 2) {
    const angle = -2 * Math.PI / length
    for (let offset = 0; offset < size; offset += length) {
      for (let index = 0; index < length / 2; index++) {
        const cos = Math.cos(angle * index)
        const sin = Math.sin(angle * index)
        const a = offset + index
        const b = a + length / 2
        const tr = real[b] * cos - imaginary[b] * sin
        const ti = real[b] * sin + imaginary[b] * cos
        real[b] = real[a] - tr
        imaginary[b] = imaginary[a] - ti
        real[a] += tr
        imaginary[a] += ti
      }
    }
  }
  const magnitude = new Float32Array(size / 2)
  for (let index = 0; index < magnitude.length; index++) magnitude[index] = Math.hypot(real[index], imaginary[index])
  return magnitude
}

self.onmessage = (event: MessageEvent<{ mono: Float32Array; sampleRate: number }>) => {
  const { mono, sampleRate } = event.data
  const count = Math.max(0, Math.floor((mono.length - size) / hop) + 1)
  const rms = new Array<number>(count)
  const flux = new Array<number>(count)
  const spectrum = new Uint8Array(count * bands)
  let previous = new Float32Array(bands)
  let maxRms = 0
  let maxFlux = 0

  for (let frame = 0; frame < count; frame++) {
    const offset = frame * hop
    const window = mono.subarray(offset, offset + size)
    let power = 0
    for (let index = 0; index < size; index++) power += window[index] * window[index]
    rms[frame] = Math.sqrt(power / size)
    maxRms = Math.max(maxRms, rms[frame])
    const magnitude = fftMagnitude(window)
    const current = new Float32Array(bands)
    let change = 0
    for (let band = 0; band < bands; band++) {
      const lowHz = 80 * (4000 / 80) ** (band / bands)
      const highHz = 80 * (4000 / 80) ** ((band + 1) / bands)
      const low = Math.max(1, Math.floor(lowHz * size / sampleRate))
      const high = Math.min(magnitude.length, Math.max(low + 1, Math.ceil(highHz * size / sampleRate)))
      let value = 0
      for (let bin = low; bin < high; bin++) value += magnitude[bin]
      current[band] = value / (high - low)
      change += Math.max(0, current[band] - previous[band])
      spectrum[frame * bands + band] = Math.round(Math.min(255, Math.max(0, 48 * Math.log1p(current[band]))))
    }
    flux[frame] = change / bands
    maxFlux = Math.max(maxFlux, flux[frame])
    previous = current
  }

  const candidates: AcousticCandidate[] = []
  const activityFloor = Math.max(0.002, maxRms * 0.07)
  const fluxFloor = maxFlux * 0.22
  for (let frame = 3; frame < count - 3; frame++) {
    const time = frame * hop / sampleRate
    if (rms[frame] >= activityFloor && rms[frame - 2] < activityFloor * 0.75 && rms[frame + 2] >= rms[frame]) {
      candidates.push({ time, strength: Math.min(1, rms[frame + 2] / Math.max(activityFloor * 5, 0.001)), kind: 'onset', reason: '人声起始与能量上升' })
    }
    if (rms[frame] >= activityFloor && flux[frame] >= fluxFloor && flux[frame] > flux[frame - 1] && flux[frame] >= flux[frame + 1]) {
      candidates.push({ time, strength: Math.min(1, flux[frame] / Math.max(maxFlux * 0.75, 0.001)), kind: 'spectrum', reason: '频谱变化峰值（可能是辅音或发音变化）' })
    }
    if (rms[frame] < activityFloor * 0.55 && rms[frame - 1] >= activityFloor * 0.55) {
      let end = frame + 1
      while (end < count && rms[end] < activityFloor * 0.55) end++
      if (end - frame >= 4 && end - frame <= 75) candidates.push({ time, strength: Math.min(1, (end - frame) / 15), kind: 'gap', reason: '短暂停顿起点' })
    }
  }
  // Suppress dense spectral peaks so snapping keeps a small, interpretable set.
  const filtered: AcousticCandidate[] = []
  for (const candidate of candidates.sort((a, b) => a.time - b.time || b.strength - a.strength)) {
    const previousCandidate = filtered[filtered.length - 1]
    if (previousCandidate && candidate.time - previousCandidate.time < 0.055) {
      if (candidate.strength > previousCandidate.strength) filtered[filtered.length - 1] = candidate
    } else filtered.push(candidate)
  }
  const result: AcousticAnalysis = { step: hop / sampleRate, bands, rms, flux, spectrum, candidates: filtered }
  self.postMessage(result, { transfer: [spectrum.buffer] })
}
