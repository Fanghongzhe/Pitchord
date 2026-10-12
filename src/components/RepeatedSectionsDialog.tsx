import { useMemo, useState } from 'react'
import { CorrespondenceMap } from '@/components/CorrespondenceMap'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatTime, parseTime, type LyricSegment } from '@/lib/lyrics'
import type { PitchPoint } from '@/lib/pitch'
import { contiguousLineIds, defaultLineLinks, orderedSections, previewSectionTransfer, resolvedLineLinks, type LineLink, type RepeatedSection } from '@/lib/repeated-sections'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  segments: LyricSegment[]
  points: PitchPoint[]
  sections: RepeatedSection[]
  onSectionsChange: (sections: RepeatedSection[]) => void
  onApply: (segments: LyricSegment[]) => void
  duration: number
  playhead: number
  onSeek: (time: number) => void
}

export function RepeatedSectionsDialog({ open, onOpenChange, segments, points, sections, onSectionsChange, onApply, duration, playhead, onSeek }: Props) {
  const ordered = useMemo(() => orderedSections(sections, segments), [sections, segments])
  const families = [...new Set(ordered.map(section => section.family))]
  const [family, setFamily] = useState('')
  const chosenFamily = families.includes(family) ? family : families[0]
  const instances = ordered.filter(section => section.family === chosenFamily)
  const source = instances[0]
  const [targetId, setTargetId] = useState('')
  const target = instances.slice(1).find(section => section.id === targetId) ?? instances[1]
  const structureChanged = [source, target].some(section => section && (section.lineIds.length !== sections.find(item => item.id === section.id)?.lineIds.length || !contiguousLineIds(segments, section.lineIds)))
  const targetFirst = segments.find(line => line.id === target?.lineIds[0])
  const [anchor, setAnchor] = useState('')
  const [anchorFor, setAnchorFor] = useState('')
  const [semitones, setSemitones] = useState(0)
  const [timing, setTiming] = useState(true)
  const [pitch, setPitch] = useState(true)
  const [preserveTargetManual, setPreserveTargetManual] = useState(true)
  const [skipConflicts, setSkipConflicts] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedLineId, setSelectedLineId] = useState('')
  const [selectedCharId, setSelectedCharId] = useState('')
  const displayedAnchor = target?.id === anchorFor ? anchor : formatTime(targetFirst?.start ?? 0)
  const anchorTime = parseTime(displayedAnchor)
  const links = source && target ? resolvedLineLinks(source, target, segments) : []
  const preview = source && target && anchorTime !== null && (timing || pitch)
    ? previewSectionTransfer(segments, points, source, target, { anchor: anchorTime, semitones, timing, pitch, preserveTargetManual, skipConflicts }, duration) : null
  const sourceLines = source?.lineIds.map(id => segments.find(line => line.id === id)).filter((line): line is LyricSegment => !!line) ?? []
  const targetLines = target?.lineIds.map(id => segments.find(line => line.id === id)).filter((line): line is LyricSegment => !!line) ?? []
  const visualTargetLine = targetLines.find(line => line.id === selectedLineId) ?? targetLines[0]
  const visualLink = links.find(link => link.targetLineId === visualTargetLine?.id)
  const visualSourceChars = sourceLines.filter(line => visualLink?.sourceLineIds.includes(line.id)).flatMap(line => line.chars)
  const visualTargetChar = visualTargetLine?.chars.find(char => char.id === selectedCharId) ?? visualTargetLine?.chars[0]

  const updateLink = (lineId: string, update: (link: LineLink) => LineLink) => {
    if (!target) return
    const nextLinks = links.map(link => link.targetLineId === lineId ? update(link) : link)
    onSectionsChange(sections.map(section => section.id === target.id ? { ...section, lineLinks: nextLinks } : section))
  }
  const chooseSourceLine = (targetLine: LyricSegment, sourceId: string, extend: boolean) => {
    if (!source || !target) return
    updateLink(targetLine.id, link => {
      const selected = extend && link.sourceLineIds.length
        ? source.lineIds.slice(Math.min(source.lineIds.indexOf(link.sourceLineIds[0]), source.lineIds.indexOf(sourceId)), Math.max(source.lineIds.indexOf(link.sourceLineIds.at(-1)!), source.lineIds.indexOf(sourceId)) + 1)
        : [sourceId]
      const regenerated = defaultLineLinks({ ...source, lineIds: selected }, { ...target, lineIds: [targetLine.id] }, segments)[0]
      return { ...link, sourceLineIds: selected, charLinks: regenerated?.charLinks ?? [], confirmed: false }
    })
    setMessage('来源句已更新，逐字对应已按顺序重新建议；请核对下方连线。')
  }
  const chooseSourceChar = (lineId: string, charId: string, sourceCharId: string, extend: boolean) => {
    updateLink(lineId, link => {
      const allowed = link.sourceLineIds.flatMap(id => segments.find(line => line.id === id)?.chars.map(char => char.id) ?? [])
      return { ...link, confirmed: false, charLinks: link.charLinks.map(item => item.targetCharId === charId ? {
        ...item, sourceCharIds: extend && item.sourceCharIds.length
          ? allowed.slice(Math.min(allowed.indexOf(item.sourceCharIds[0]), allowed.indexOf(sourceCharId)), Math.max(allowed.indexOf(item.sourceCharIds.at(-1)!), allowed.indexOf(sourceCharId)) + 1)
          : [sourceCharId],
      } : item) }
    })
  }
  const apply = () => {
    if (!preview || !preview.changes || structureChanged || (!skipConflicts && preview.issues)) return
    onApply(preview.segments)
    setMessage(`已同步 ${preview.changes} 句${preview.issues ? `；跳过 ${preview.issues} 句有冲突的对应` : ''}。可用主界面的撤回恢复。`)
    const next = instances.find(item => item.ordinal === (target?.ordinal ?? 0) + 1)
    if (next) setTargetId(next.id)
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto" aria-label="已识别到的同类段落">
    <DialogHeader><DialogTitle>已识别到的同类段落</DialogTitle><DialogDescription>先核对 A1 与 A2／A3 的逐句、逐字对应，再逐段指定首句起点并预览同步。未标记的段落不会改变。</DialogDescription></DialogHeader>
    {!ordered.length ? <p className="py-5 text-sm text-muted-foreground">请先在歌词列表连续选择若干句，标记为 A、B 等段落。</p> : <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2"><label className="w-32 space-y-1 text-xs text-muted-foreground">段落类别<Select value={chosenFamily} onValueChange={value => { setFamily(value); setTargetId(''); setAnchorFor('') }}><SelectTrigger aria-label="段落类别"><SelectValue /></SelectTrigger><SelectContent>{families.map(item => <SelectItem key={item} value={item}>{item} 段</SelectItem>)}</SelectContent></Select></label><div className="flex flex-wrap gap-1">{instances.map(section => <span key={section.id} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1"><Badge variant={target?.id === section.id ? 'secondary' : 'outline'}>{section.label} · {section.lineIds.length} 句</Badge><button type="button" aria-label={`移除 ${section.label} 标记`} title={`移除 ${section.label} 标记，不删除歌词`} className="rounded px-1 text-muted-foreground hover:text-destructive" onClick={() => { onSectionsChange(sections.filter(item => item.id !== section.id)); setTargetId(''); setAnchorFor('') }}>×</button></span>)}</div></div>
      <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2"><div><p className="text-sm font-medium">来源：{source?.label}</p><p className="mt-1 text-xs text-muted-foreground">以已校对的时间和当前生效音高作为模板，不移动原始 F0。</p></div><label className="space-y-1 text-xs text-muted-foreground">目标段<Select value={target?.id ?? ''} onValueChange={value => { setTargetId(value); setAnchorFor(''); setMessage('') }}><SelectTrigger aria-label="目标同类段落"><SelectValue placeholder="先标记第二个同类段落" /></SelectTrigger><SelectContent>{instances.slice(1).map(item => <SelectItem key={item.id} value={item.id}>{item.label} · {item.lineIds.length} 句</SelectItem>)}</SelectContent></Select></label></div>
      {source && target && <>
        {structureChanged && <p className="rounded-md border border-orange-400/50 bg-orange-400/5 p-2 text-xs text-orange-600">同类段标记后，相关歌词句被删除、分割或插入。为防止错位同步，请先移除受影响的段落标记，再按当前换行重新标记。</p>}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div><p className="text-sm font-medium">对应关系一览 · {source.label} → {target.label}</p><p className="mt-1 text-xs text-muted-foreground">上方为已校对段，下方为待同步段。下划线和连线表示对应；点目标句或字／词，再点来源进行调整，Shift 点击来源可扩展连续范围。</p></div>
          {sourceLines.length !== targetLines.length && <p className="rounded-md bg-orange-400/10 p-2 text-xs text-orange-600" role="alert">两段句数不一致。已按顺序给出默认对应，请逐句核对。</p>}
          <CorrespondenceMap source={sourceLines.map((line, index) => ({ id: line.id, label: `${index + 1}. ${line.text}` }))} target={targetLines.map((line, index) => ({ id: line.id, label: `${index + 1}. ${line.text}` }))} links={links.map(link => ({ targetId: link.targetLineId, sourceIds: link.sourceLineIds }))} sourceLabel={`${source.label} · 来源句`} targetLabel={`${target.label} · 目标句`} selectedTargetId={visualTargetLine?.id} onTargetSelect={setSelectedLineId} onSourceSelect={(id, extend) => visualTargetLine && chooseSourceLine(visualTargetLine, id, extend)} />
          {visualTargetLine && <>
            <div className="flex flex-wrap items-center gap-2 text-xs"><Badge variant="secondary">{target.label} 第 {targetLines.indexOf(visualTargetLine) + 1} 句</Badge><span className="truncate">{visualTargetLine.text}</span>{(sourceLines.length !== targetLines.length || visualSourceChars.length !== visualTargetLine.chars.length) && <><span className="text-orange-600" role="alert">句数或字／词数不一致：默认对应仅供参考，需核对确认。</span><Button size="sm" variant={visualLink?.confirmed ? 'secondary' : 'outline'} className="h-7" onClick={() => updateLink(visualTargetLine.id, link => ({ ...link, confirmed: !link.confirmed }))}>{visualLink?.confirmed ? '已确认本句对应' : '确认本句对应'}</Button></>}</div>
            <CorrespondenceMap source={visualSourceChars.map(char => ({ id: char.id, label: char.text }))} target={visualTargetLine.chars.map(char => ({ id: char.id, label: char.text }))} links={(visualLink?.charLinks ?? []).map(link => ({ targetId: link.targetCharId, sourceIds: link.sourceCharIds }))} sourceLabel={`${source.label} · 字／词（英文单词如 yeah 作为一个单位）`} targetLabel={`${target.label} · 字／词`} selectedTargetId={visualTargetChar?.id} onTargetSelect={setSelectedCharId} onSourceSelect={(id, extend) => visualTargetChar && chooseSourceChar(visualTargetLine.id, visualTargetChar.id, id, extend)} />
          </>}
        </div>
        <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">高级逐句／逐字调整 · 查看全部对应</summary><div className="mt-3 space-y-2"><p className="text-xs text-muted-foreground">点击来源替换当前对应；按住 Shift 点击可扩展为连续范围。英文词作为一个整体单位。</p>
          <div className="max-h-80 space-y-2 overflow-y-auto">{targetLines.map((line, index) => {
            const link = links.find(item => item.targetLineId === line.id)
            const mappedLines = sourceLines.filter(item => link?.sourceLineIds.includes(item.id))
            const sourceChars = mappedLines.flatMap(item => item.chars)
            const row = preview?.rows.find(item => item.targetLineId === line.id)
            return <div key={line.id} className="rounded-md border border-border/80 p-2 text-xs"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{target.label} · 第 {index + 1} 句</Badge><button type="button" className="min-w-0 flex-1 truncate text-left hover:text-primary" onClick={() => onSeek(line.start)}>{line.text}</button><span className="font-mono text-muted-foreground">{formatTime(line.start)}</span></div>
              <div className="mt-2 flex flex-wrap items-center gap-1"><span className="mr-1 text-muted-foreground">对应 {source.label}：</span>{sourceLines.map((item, sourceIndex) => <Button key={item.id} type="button" size="sm" variant={link?.sourceLineIds.includes(item.id) ? 'secondary' : 'outline'} className="h-7 max-w-40 truncate px-2 text-xs" title={item.text} onClick={event => chooseSourceLine(line, item.id, event.shiftKey)}>{sourceIndex + 1}. {item.text}</Button>)}</div>
              <details className="mt-2"><summary className="cursor-pointer text-primary">逐字对应 · {line.chars.length} 字／词</summary><div className="mt-2 space-y-1.5">{line.chars.map((char, charIndex) => { const charLink = link?.charLinks.find(item => item.targetCharId === char.id); return <div key={char.id} className="flex flex-wrap items-center gap-1 border-t border-border/50 pt-1.5"><span className="min-w-16 text-muted-foreground">{charIndex + 1}. {char.text} ←</span>{sourceChars.map((sourceChar, sourceIndex) => <Button key={sourceChar.id} size="sm" variant={charLink?.sourceCharIds.includes(sourceChar.id) ? 'secondary' : 'outline'} className="h-6 min-w-6 px-1 text-xs" title={`${sourceIndex + 1}. ${sourceChar.text}`} onClick={event => chooseSourceChar(line.id, char.id, sourceChar.id, event.shiftKey)}>{sourceChar.text}</Button>)}</div> })}</div></details>
              {row?.issues.length ? <p className="mt-2 text-orange-600">需处理：{row.issues.join('；')}</p> : null}
            </div>
          })}</div>
        </div></details>
        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2"><div className="space-y-2"><label className="block space-y-1 text-xs text-muted-foreground">{target.label} 首句起点<Input value={displayedAnchor} onChange={event => { setAnchorFor(target.id); setAnchor(event.target.value) }} aria-label="目标首句起点" className="font-mono" placeholder="00:00.000" /></label><div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={() => { setAnchorFor(target.id); setAnchor(formatTime(playhead)) }}>取当前播放位置</Button><Button size="sm" variant="outline" onClick={() => onSeek(targetFirst?.start ?? 0)}>试听目标首句</Button><Button size="sm" variant="outline" onClick={() => { setAnchorFor(target.id); setAnchor(formatTime(targetFirst?.start ?? 0)) }}>恢复原起点</Button></div><p className="text-xs text-muted-foreground">确定首句位置后，其余整句和逐字相对时值按 {source.label} 传递。</p></div><div className="space-y-2"><label className="block space-y-1 text-xs text-muted-foreground">整体升降调（半音）<Input type="number" min={-24} max={24} step={1} value={semitones} onChange={event => setSemitones(Math.max(-24, Math.min(24, Math.round(Number(event.target.value) || 0))))} aria-label="整体升降调半音" /></label><p className="text-xs text-muted-foreground">0 为原 Key；少数字的变调可在同步后单独修改。同步音高保存为人工结果。</p></div></div>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant={timing ? 'secondary' : 'outline'} onClick={() => setTiming(value => !value)} aria-pressed={timing}>同步时间 · {timing ? '开' : '关'}</Button><Button size="sm" variant={pitch ? 'secondary' : 'outline'} onClick={() => setPitch(value => !value)} aria-pressed={pitch}>同步音高 · {pitch ? '开' : '关'}</Button><Button size="sm" variant={preserveTargetManual ? 'secondary' : 'outline'} onClick={() => setPreserveTargetManual(value => !value)} aria-pressed={preserveTargetManual}>保留目标已有人工音高 · {preserveTargetManual ? '开' : '关'}</Button><Button size="sm" variant={skipConflicts ? 'secondary' : 'outline'} onClick={() => setSkipConflicts(value => !value)} aria-pressed={skipConflicts}>跳过冲突句 · {skipConflicts ? '开' : '关'}</Button></div>
        {preview && <div className="rounded-lg border border-border p-3"><p className="mb-2 text-sm font-medium">同步预览：{preview.changes} 句可更新，{preview.issues} 句需处理</p>{preview.manualOverwrites > 0 && <p className="mb-2 text-xs text-orange-600">将覆盖目标段已有的 {preview.manualOverwrites} 个字的人工音高；可重新开启“保留目标已有人工音高”。</p>}<div className="max-h-36 space-y-1 overflow-y-auto text-xs">{preview.rows.map(row => <div key={row.targetLineId} className="flex flex-wrap gap-2"><span className="min-w-44 truncate">{segments.find(line => line.id === row.targetLineId)?.text}</span><span className="font-mono text-muted-foreground">{formatTime(row.before[0])}–{formatTime(row.before[1])}</span><span>→</span><span className="font-mono">{formatTime(row.after[0])}–{formatTime(row.after[1])}</span>{row.issues.length ? <span className="text-orange-600">{row.issues.join('；')}</span> : <span className="text-emerald-600">可同步</span>}</div>)}</div><p className="mt-2 text-xs text-muted-foreground">冲突时默认不应用任何句；可修改锚点／对应关系，或开启“跳过冲突句”。也可关闭时间同步，仅传递音高。</p></div>}
      </>}
      {message && <p className="text-xs text-primary" role="status">{message}</p>}
    </div>}
    <DialogFooter className="flex-wrap"><Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button><Button onClick={apply} disabled={!preview?.changes || structureChanged || (!skipConflicts && !!preview.issues)}>确认同步到 {target?.label ?? '目标段'}</Button></DialogFooter>
  </DialogContent></Dialog>
}
