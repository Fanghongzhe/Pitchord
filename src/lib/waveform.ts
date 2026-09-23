/** Read just the audio track, including when it is inside a video container. */
export async function extractWaveform(file: File, isCurrent: () => boolean): Promise<number[]> {
  const { Input, ALL_FORMATS, BlobSource, AudioBufferSink } = await import('mediabunny')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !await track.canDecode()) throw new Error('No decodable audio track')
    const duration = await input.computeDuration()
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid duration')
    const count = Math.min(6000, Math.max(600, Math.ceil(duration * 30)))
    const peaks = new Array<number>(count).fill(0)
    const sink = new AudioBufferSink(track)
    for await (const { buffer, timestamp } of sink.buffers()) {
      if (!isCurrent()) return []
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
      const stride = Math.max(1, Math.floor(buffer.length / 80))
      for (let index = 0; index < buffer.length; index += stride) {
        const bin = Math.floor((timestamp + index / buffer.sampleRate) / duration * count)
        if (bin < 0 || bin >= count) continue
        let amplitude = 0
        for (const channel of channels) amplitude = Math.max(amplitude, Math.abs(channel[index]))
        peaks[bin] = Math.max(peaks[bin], amplitude)
      }
    }
    const max = Math.max(...peaks, 0.01)
    return peaks.map(peak => Math.min(1, peak / max))
  } finally {
    input.dispose()
  }
}

/** Decode a media file's primary audio track into a Web Audio buffer for analysis. */
export async function extractAudioBuffer(file: File, isCurrent: () => boolean): Promise<AudioBuffer> {
  const { Input, ALL_FORMATS, BlobSource, AudioBufferSink } = await import('mediabunny')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !await track.canDecode()) throw new Error('No decodable audio track')
    const duration = await input.computeDuration()
    const sink = new AudioBufferSink(track)
    const buffers: { buffer: AudioBuffer; timestamp: number }[] = []
    for await (const item of sink.buffers()) {
      if (!isCurrent()) throw new Error('Cancelled')
      buffers.push(item)
    }
    const first = buffers[0]?.buffer
    if (!first || !Number.isFinite(duration) || duration <= 0) throw new Error('No audio samples')
    const context = new AudioContext()
    try {
      const output = context.createBuffer(first.numberOfChannels, Math.ceil(duration * first.sampleRate), first.sampleRate)
      for (const item of buffers) {
        const offset = Math.max(0, Math.round(item.timestamp * output.sampleRate))
        for (let channel = 0; channel < output.numberOfChannels; channel++) {
          const source = item.buffer.getChannelData(Math.min(channel, item.buffer.numberOfChannels - 1))
          output.getChannelData(channel).set(source.subarray(0, Math.max(0, output.length - offset)), offset)
        }
      }
      return output
    } finally { void context.close() }
  } finally { input.dispose() }
}
