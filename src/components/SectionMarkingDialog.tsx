import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { LyricSegment } from '@/lib/lyrics'
import { clearSectionMark, contiguousLineIds, orderedSections, type RepeatedSection } from '@/lib/repeated-sections'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  segments: LyricSegment[]
  sections: RepeatedSection[]
  onSectionsChange: (sections: RepeatedSection[]) => void
  initialLineIds: string[]
  onReview: () => void
}

export function SectionMarkingDialog({ open, onOpenChange, segments, sections, onSectionsChange, initialLineIds, onReview }: Props) {
  const initial = contiguousLineIds(segments, initialLineIds)
  const initialFrom = Math.max(0, initial ? segments.findIndex(line => line.id === initial[0]) : 0)
  const initialTo = Math.max(0, initial ? segments.findIndex(line => line.id === initial.at(-1)) : initialFrom)
  const [family, setFamily] = useState('A')
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [message, setMessage] = useState('')
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const ordered = useMemo(() => orderedSections(sections, segments), [sections, segments])
  const labels = new Map(ordered.flatMap(section => section.lineIds.map(id => [id, section.label] as const)))
  const nextNumber = ordered.filter(section => section.family === family).length + 1
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  const selected = segments.slice(start, end + 1)
  const overlap = selected.find(line => labels.has(line.id))
  const selectedSections = ordered.filter(section => section.lineIds.some(id => selected.some(line => line.id === id)))
  const selectedSection = selectedSections.length === 1 ? selectedSections[0] : null

  const clearMark = (section: RepeatedSection & { label: string }) => {
    onSectionsChange(clearSectionMark(sections, segments, section.id))
    setConfirmClearAll(false)
    setMessage(`已清除 ${section.label} 标记；歌词、时间和音高未改变。`)
  }

  const mark = () => {
    if (!selected.length || overlap) return
    const next = [...sections, { id: crypto.randomUUID(), family, lineIds: selected.map(line => line.id), lineLinks: [] }]
    onSectionsChange(next)
    const added = orderedSections(next, segments).find(section => section.id === next.at(-1)?.id)
    setMessage(`已标记 ${added?.label}（${selected.length} 句）。可继续选择同类段落。`)
    const nextFree = segments.findIndex((line, index) => index > end && !next.some(section => section.lineIds.includes(line.id)))
    if (nextFree >= 0) { setFrom(nextFree); setTo(nextFree) }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" aria-label="标记同类段落">
    <DialogHeader><DialogTitle>标记同类段落</DialogTitle><DialogDescription>按参考歌词换行选择一段连续的句子。同一字母的段落会按歌词顺序自动编号；标记本身不会修改时间或音高。</DialogDescription></DialogHeader>
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3">
      <label className="w-24 space-y-1 text-xs text-muted-foreground">类别<Select value={family} onValueChange={setFamily}><SelectTrigger aria-label="段落类别字母"><SelectValue /></SelectTrigger><SelectContent>{'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => <SelectItem key={letter} value={letter}>{letter}</SelectItem>)}</SelectContent></Select></label>
      <label className="min-w-36 flex-1 space-y-1 text-xs text-muted-foreground">从第几句<Select value={String(from)} onValueChange={value => setFrom(Number(value))}><SelectTrigger aria-label="段落起始句"><SelectValue /></SelectTrigger><SelectContent>{segments.map((line, index) => <SelectItem key={line.id} value={String(index)}>{index + 1}. {line.text}</SelectItem>)}</SelectContent></Select></label>
      <label className="min-w-36 flex-1 space-y-1 text-xs text-muted-foreground">到第几句<Select value={String(to)} onValueChange={value => setTo(Number(value))}><SelectTrigger aria-label="段落结束句"><SelectValue /></SelectTrigger><SelectContent>{segments.map((line, index) => <SelectItem key={line.id} value={String(index)}>{index + 1}. {line.text}</SelectItem>)}</SelectContent></Select></label>
      <Badge variant="secondary">将标记为 {family}{nextNumber}</Badge>
    </div>
    <p className="text-xs text-muted-foreground">可直接点选一句；按住 Shift 再点另一句可选择连续范围。点击已有标记的句子会选中整段，方便清除或重新标记。</p>
    <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-2" aria-label="段落歌词句选择">{segments.map((line, index) => <button key={line.id} type="button" className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${index >= start && index <= end ? 'bg-primary/15 ring-1 ring-primary/50' : ''}`} onClick={event => { if (event.shiftKey) { setTo(index); return } const marked = ordered.find(section => section.lineIds.includes(line.id)); if (marked) { setFrom(segments.findIndex(item => item.id === marked.lineIds[0])); setTo(segments.findIndex(item => item.id === marked.lineIds.at(-1))) } else { setFrom(index); setTo(index) } }}><span className="w-7 shrink-0 text-xs text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 truncate">{line.text}</span>{labels.has(line.id) && <Badge variant="outline">{labels.get(line.id)}</Badge>}</button>)}</div>
    {overlap && <p className="text-xs text-orange-600" role="alert">所选句子已有标记。可先清除相应段落标记，再重新选择。</p>}
    {ordered.length > 0 && <div className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">已有标记 · {ordered.length} 段</span><Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmClearAll(true)}>清除全部标记…</Button></div><div className="mt-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto">{ordered.map(section => <span key={section.id} className="flex items-center gap-1 rounded-md border border-border p-1 text-xs"><Badge variant="secondary">{section.label}</Badge><span>{section.lineIds.length} 句</span><button type="button" className="rounded px-1 text-muted-foreground hover:text-destructive" aria-label={`清除 ${section.label} 标记`} onClick={() => clearMark(section)}>清除</button></span>)}</div>{confirmClearAll && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 p-2 text-xs"><span className="min-w-0 flex-1">清除全部 {ordered.length} 段标记及对应关系？歌词、时间和音高不变。</span><Button type="button" size="sm" variant="outline" onClick={() => setConfirmClearAll(false)}>取消</Button><Button type="button" size="sm" variant="destructive" onClick={() => { onSectionsChange([]); setConfirmClearAll(false); setMessage('已清除全部段落标记；歌词、时间和音高未改变。') }}>确认清除全部</Button></div>}</div>}
    {message && <p className="text-xs text-primary" role="status">{message}</p>}
    <DialogFooter className="flex-wrap"><Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button><Button variant="outline" onClick={() => { onOpenChange(false); onReview() }} disabled={ordered.length < 2}>核对对应关系</Button>{selectedSection && <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => clearMark(selectedSection)}>清除 {selectedSection.label} 标记</Button>}<Button onClick={mark} disabled={!selected.length || !!overlap}>标记 {family}{nextNumber} · {selected.length} 句</Button></DialogFooter>
  </DialogContent></Dialog>
}
