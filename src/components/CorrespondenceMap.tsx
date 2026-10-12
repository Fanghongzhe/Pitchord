import { useLayoutEffect, useRef, useState } from 'react'

export type MapItem = { id: string; label: string }
type Link = { targetId: string; sourceIds: string[] }
type Props = {
  source: MapItem[]
  target: MapItem[]
  links: Link[]
  sourceLabel: string
  targetLabel: string
  selectedTargetId?: string
  onTargetSelect?: (id: string) => void
  onSourceSelect?: (id: string, extend: boolean) => void
}

export function CorrespondenceMap({ source, target, links, sourceLabel, targetLabel, selectedTargetId, onTargetSelect, onSourceSelect }: Props) {
  const canvas = useRef<HTMLDivElement>(null)
  const sourceNodes = useRef(new Map<string, HTMLButtonElement>())
  const targetNodes = useRef(new Map<string, HTMLButtonElement>())
  const [paths, setPaths] = useState<string[]>([])
  const [size, setSize] = useState({ width: 0, height: 0 })
  const key = JSON.stringify({ source: source.map(item => item.id), target: target.map(item => item.id), links })

  useLayoutEffect(() => {
    const element = canvas.current
    if (!element) return
    const measure = () => {
      const root = element.getBoundingClientRect()
      const next = links.flatMap(link => link.sourceIds.flatMap(sourceId => {
        const from = sourceNodes.current.get(sourceId)?.getBoundingClientRect()
        const to = targetNodes.current.get(link.targetId)?.getBoundingClientRect()
        if (!from || !to) return []
        const x1 = from.left + from.width / 2 - root.left
        const y1 = from.bottom - root.top + 2
        const x2 = to.left + to.width / 2 - root.left
        const y2 = to.top - root.top - 2
        const mid = (y1 + y2) / 2
        return [`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`]
      }))
      setPaths(next)
      setSize({ width: element.clientWidth, height: element.clientHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [key, links])

  const mappedSource = new Set(links.flatMap(link => link.sourceIds))
  const mappedTarget = new Set(links.filter(link => link.sourceIds.length).map(link => link.targetId))
  return <div className="overflow-x-auto rounded-lg border border-border bg-muted/10 p-3">
    <div ref={canvas} className="relative space-y-12" style={{ minWidth: Math.max(340, source.length * 55, target.length * 55) }}>
      <svg className="pointer-events-none absolute inset-0 z-0 text-primary/60" width={size.width} height={size.height} aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="1.5">{paths.map((path, index) => <path key={`${index}-${path}`} d={path} />)}</g></svg>
      <div className="relative z-10"><p className="mb-2 text-[11px] text-muted-foreground">{sourceLabel}</p><div className="flex justify-around gap-1">{source.map(item => <button key={item.id} type="button" ref={node => { if (node) sourceNodes.current.set(item.id, node); else sourceNodes.current.delete(item.id) }} className={`min-w-8 max-w-40 truncate border-b-2 px-1.5 py-1 text-center text-sm ${mappedSource.has(item.id) ? 'border-primary' : 'border-transparent'} ${onSourceSelect ? 'cursor-pointer rounded hover:bg-primary/10' : 'cursor-default'}`} title={item.label} onClick={event => onSourceSelect?.(item.id, event.shiftKey)}>{item.label}</button>)}</div></div>
      <div className="relative z-10"><div className="flex justify-around gap-1">{target.map(item => <button key={item.id} type="button" ref={node => { if (node) targetNodes.current.set(item.id, node); else targetNodes.current.delete(item.id) }} className={`min-w-8 max-w-40 truncate rounded border-b-2 px-1.5 py-1 text-center text-sm ${mappedTarget.has(item.id) ? 'border-primary' : 'border-transparent'} ${selectedTargetId === item.id ? 'bg-primary/15 ring-1 ring-primary/50' : ''} ${onTargetSelect ? 'hover:bg-primary/10' : 'cursor-default'}`} title={item.label} onClick={() => onTargetSelect?.(item.id)}>{item.label}</button>)}</div><p className="mt-2 text-[11px] text-muted-foreground">{targetLabel}</p></div>
    </div>
  </div>
}
