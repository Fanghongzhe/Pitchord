export type StemKind = 'original' | 'vocals' | 'harmonies' | 'accompaniment'
type BufferStemKind = Exclude<StemKind, 'original'>

/** Decoded stems share one audio clock. The media element remains the video and seek clock. */
export class StemMixer {
  private readonly context = new AudioContext({ latencyHint: 'interactive' })
  private readonly gains: Record<StemKind, GainNode>
  private readonly buffers: Record<BufferStemKind, AudioBuffer | null> = { vocals: null, harmonies: null, accompaniment: null }
  private readonly sources: Record<BufferStemKind, AudioBufferSourceNode | null> = { vocals: null, harmonies: null, accompaniment: null }
  private readonly mediaNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
  private attachedMediaNode: MediaElementAudioSourceNode | null = null
  private media: HTMLMediaElement | null = null
  private generation = 0
  private running = false
  private estimatedPosition = 0
  private lastContextTime = 0
  private effectiveRate = 1

  constructor() {
    const original = this.context.createGain()
    const vocals = this.context.createGain()
    const harmonies = this.context.createGain()
    const accompaniment = this.context.createGain()
    original.gain.value = 1
    vocals.gain.value = 0
    harmonies.gain.value = 0
    accompaniment.gain.value = 0
    original.connect(this.context.destination)
    vocals.connect(this.context.destination)
    harmonies.connect(this.context.destination)
    accompaniment.connect(this.context.destination)
    this.gains = { original, vocals, harmonies, accompaniment }
  }

  attachMedia(media: HTMLMediaElement) {
    if (this.media === media && this.attachedMediaNode) return
    this.attachedMediaNode?.disconnect()
    let node = this.mediaNodes.get(media)
    if (!node) {
      node = this.context.createMediaElementSource(media)
      this.mediaNodes.set(media, node)
    }
    node.connect(this.gains.original)
    this.attachedMediaNode = node
    this.media = media
  }

  async load(kind: BufferStemKind, file: File): Promise<AudioBuffer> {
    const buffer = await this.context.decodeAudioData(await file.arrayBuffer())
    this.stopTrack(kind)
    this.buffers[kind] = buffer
    if (this.running && this.media && !this.media.paused) this.startTrack(kind, this.media.currentTime, this.media.playbackRate)
    return buffer
  }

  has(kind: BufferStemKind) { return !!this.buffers[kind] }

  unload(kind: BufferStemKind) {
    this.stopTrack(kind)
    this.buffers[kind] = null
  }

  setGain(kind: StemKind, enabled: boolean, volume: number) {
    const gain = this.gains[kind].gain
    const now = this.context.currentTime
    gain.cancelScheduledValues(now)
    gain.setTargetAtTime(enabled ? Math.max(0, Math.min(2, volume / 100)) : 0, now, 0.012)
  }

  async play(media: HTMLMediaElement) {
    const request = ++this.generation
    this.media = media
    await this.context.resume()
    if (request !== this.generation || media.paused) return
    this.startAll(media)
  }

  pause() {
    this.generation++
    this.running = false
    this.stopTrack('vocals')
    this.stopTrack('harmonies')
    this.stopTrack('accompaniment')
  }

  clear() {
    this.pause()
    this.attachedMediaNode?.disconnect()
    this.attachedMediaNode = null
    this.media = null
    this.buffers.vocals = null
    this.buffers.harmonies = null
    this.buffers.accompaniment = null
  }

  async close() {
    this.clear()
    await this.context.close()
  }

  sync(media: HTMLMediaElement) {
    if (!this.running || media.seeking || media.paused) return
    const now = this.context.currentTime
    this.estimatedPosition += (now - this.lastContextTime) * this.effectiveRate
    this.lastContextTime = now
    const drift = media.currentTime - this.estimatedPosition
    if (Math.abs(drift) > 0.75) { this.startAll(media); return }
    this.effectiveRate = media.playbackRate * (1 + Math.max(-0.01, Math.min(0.01, drift * 0.08)))
    for (const kind of ['vocals', 'harmonies', 'accompaniment'] as const) {
      this.sources[kind]?.playbackRate.setTargetAtTime(this.effectiveRate, now, 0.05)
    }
  }

  rateChanged(media: HTMLMediaElement) {
    if (this.running) this.startAll(media)
  }

  private startAll(media: HTMLMediaElement) {
    this.stopTrack('vocals')
    this.stopTrack('harmonies')
    this.stopTrack('accompaniment')
    this.media = media
    this.running = true
    this.estimatedPosition = media.currentTime
    this.lastContextTime = this.context.currentTime
    this.effectiveRate = media.playbackRate
    this.startTrack('vocals', media.currentTime, media.playbackRate)
    this.startTrack('harmonies', media.currentTime, media.playbackRate)
    this.startTrack('accompaniment', media.currentTime, media.playbackRate)
  }

  private startTrack(kind: BufferStemKind, offset: number, rate: number) {
    const buffer = this.buffers[kind]
    if (!buffer || offset >= buffer.duration) return
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = rate
    source.connect(this.gains[kind])
    source.onended = () => { if (this.sources[kind] === source) this.sources[kind] = null; source.disconnect() }
    this.sources[kind] = source
    source.start(0, Math.max(0, offset))
  }

  private stopTrack(kind: BufferStemKind) {
    const source = this.sources[kind]
    this.sources[kind] = null
    if (source) { source.onended = null; try { source.stop() } catch { /* already ended */ }; source.disconnect() }
  }
}
