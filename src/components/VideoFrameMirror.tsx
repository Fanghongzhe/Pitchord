import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

type Props = {
  mediaRef: RefObject<HTMLMediaElement | null>
}

// Draw the existing player frame so the style dialog never opens a second decoder.
export function VideoFrameMirror({ mediaRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let animationFrame = 0
    let lastDraw = 0
    const video = mediaRef.current
    const drawFrame = () => {
      const video = mediaRef.current
      const canvas = canvasRef.current
      if (!(video instanceof HTMLVideoElement) || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return
      const width = Math.min(video.videoWidth, 960)
      const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      canvas.getContext('2d')?.drawImage(video, 0, 0, width, height)
    }
    const draw = (stamp: number) => {
      if (stamp - lastDraw >= 33) {
        drawFrame()
        lastDraw = stamp
      }
      animationFrame = requestAnimationFrame(draw)
    }
    drawFrame()
    if (video instanceof HTMLVideoElement) for (const event of ['loadeddata', 'seeked', 'timeupdate']) video.addEventListener(event, drawFrame)
    animationFrame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(animationFrame)
      if (video instanceof HTMLVideoElement) for (const event of ['loadeddata', 'seeked', 'timeupdate']) video.removeEventListener(event, drawFrame)
    }
  }, [mediaRef])

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="当前视频画面" />
}
