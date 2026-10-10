export type AcousticCandidate = {
  time: number
  strength: number
  kind: 'onset' | 'spectrum' | 'gap'
  reason: string
}

export type AcousticAnalysis = {
  step: number
  bands: number
  rms: number[]
  flux: number[]
  spectrum: Uint8Array
  candidates: AcousticCandidate[]
}

/** Analyze a selected vocal stem once. The worker keeps FFT work off the editor's UI thread. */
export function analyzeVocalAcoustics(buffer: AudioBuffer): Promise<AcousticAnalysis> {
  const source = buffer.getChannelData(0)
  const sampleRate = 8000
  const mono = new Float32Array(Math.ceil(buffer.duration * sampleRate))
  for (let index = 0; index < mono.length; index++) {
    const position = index * buffer.sampleRate / sampleRate
    const left = Math.min(source.length - 1, Math.floor(position))
    const right = Math.min(source.length - 1, left + 1)
    mono[index] = source[left] * (1 - (position - left)) + source[right] * (position - left)
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./acoustics.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => { worker.terminate(); resolve(event.data as AcousticAnalysis) }
    worker.onerror = error => { worker.terminate(); reject(error) }
    worker.postMessage({ mono, sampleRate }, [mono.buffer])
  })
}
