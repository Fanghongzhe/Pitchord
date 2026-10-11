import { useMemo } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { noteName, type PitchPoint } from '@/lib/pitch'
import { detectedPitchRange, pitchColor, pitchColorBandNames, recommendedPitchColorRules, type PitchColorRule, type SubtitleStyle } from '@/lib/subtitles'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  style: SubtitleStyle
  onChange: (style: SubtitleStyle) => void
  points: PitchPoint[]
}

const noteOptions = Array.from({ length: 73 }, (_, index) => index + 36)
const noteLabel = (midi: number) => noteName(440 * 2 ** ((midi - 69) / 12))
export function PitchColorBandEditor({ open, onOpenChange, style, onChange, points }: Props) {
  const range = useMemo(() => detectedPitchRange(points), [points])
  const rules = style.colorRules ?? []
  const updateRules = (next: PitchColorRule[]) => onChange({ ...style, colorBand: 'ranges', colorRules: next })
  const updateRule = (id: string, patch: Partial<PitchColorRule>) => updateRules(rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule))
  const moveRule = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= rules.length) return
    const next = [...rules]
    ;[next[index], next[target]] = [next[target], next[index]]
    updateRules(next)
  }
  const previewStart = Math.max(36, Math.min(48, range?.minMidi ?? 48, ...rules.map(rule => rule.fromMidi)))
  const previewEnd = Math.min(108, Math.max(74, range?.maxMidi ?? 74, ...rules.map(rule => rule.toMidi)))
  const previewNotes = Array.from({ length: Math.min(49, previewEnd - previewStart + 1) }, (_, index) => previewStart + index)

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>设置歌词音高色带</DialogTitle>
        <DialogDescription>颜色跟随当前 F0；唱完的字保留最后颜色。分段规则按音名匹配，区间外可指定备用颜色。</DialogDescription>
      </DialogHeader>

      <section className="space-y-3">
        <p className="text-sm font-medium">快速选择</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {(['rainbow', 'cool', 'warm', 'custom', 'ranges'] as const).map(band => <Button key={band} type="button" size="sm" variant={style.colorBand === band ? 'secondary' : 'outline'} onClick={() => onChange({ ...style, colorBand: band, colorRules: band === 'ranges' && !rules.length ? recommendedPitchColorRules(range) : rules })}>{pitchColorBandNames[band]}</Button>)}
        </div>
        {style.colorBand === 'custom' && <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">低音色（C2）<Input type="color" value={style.lowColor} onChange={event => onChange({ ...style, lowColor: event.target.value })} /></label>
          <label className="space-y-1 text-xs text-muted-foreground">高音色（C6）<Input type="color" value={style.highColor} onChange={event => onChange({ ...style, highColor: event.target.value })} /></label>
        </div>}
      </section>

      <section className="rounded-xl border border-border bg-muted/20 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">本工程音高范围</p>
            <p className="mt-1 text-xs text-muted-foreground">{range ? `模型可信 F0：${noteLabel(range.minMidi)}（${range.minHz.toFixed(1)} Hz）— ${noteLabel(range.maxMidi)}（${range.maxHz.toFixed(1)} Hz），${range.count} 个采样点` : '尚无有效音高轨迹；先识别音高后可自动扩展推荐范围。'}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">优先采用置信度 ≥ 0.5 的有效人声点；极端误检仍可手动修改区间端点。</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange({ ...style, colorBand: 'ranges', colorRules: recommendedPitchColorRules(range), rangeFallback: 'base' })}>套用冷／灰／暖三段推荐</Button>
        </div>
      </section>

      {style.colorBand === 'ranges' && <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="text-sm font-medium">分段规则</p><p className="text-xs text-muted-foreground">每段以音名为界；从上到下优先，允许重叠。例：[C4, E4) 不含 E4，[E4, D5] 包含 D5。</p></div>
          <Button type="button" size="sm" variant="outline" onClick={() => updateRules([...rules, { id: crypto.randomUUID(), fromMidi: 60, toMidi: 64, includeEnd: false, mode: 'solid', lowColor: '#9CA3AF', highColor: '#9CA3AF' }])}><Plus className="size-4" />添加音域</Button>
        </div>
        {rules.map((rule, index) => <div key={rule.id} className="space-y-3 rounded-lg border border-border bg-background p-3">
          <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">区间 {index + 1} · [{noteLabel(rule.fromMidi)}, {noteLabel(rule.toMidi)}{rule.includeEnd ? ']' : ')'}</p><div className="flex gap-1"><Button type="button" size="icon" variant="ghost" aria-label={`上移区间 ${index + 1}`} disabled={index === 0} onClick={() => moveRule(index, -1)}><ChevronUp className="size-4" /></Button><Button type="button" size="icon" variant="ghost" aria-label={`下移区间 ${index + 1}`} disabled={index === rules.length - 1} onClick={() => moveRule(index, 1)}><ChevronDown className="size-4" /></Button><Button type="button" size="icon" variant="ghost" aria-label={`删除区间 ${index + 1}`} onClick={() => updateRules(rules.filter(item => item.id !== rule.id))}><Trash2 className="size-4" /></Button></div></div>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="space-y-1 text-xs text-muted-foreground">最低音<select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={rule.fromMidi} onChange={event => updateRule(rule.id, { fromMidi: Number(event.target.value) })}>{noteOptions.map(midi => <option key={midi} value={midi}>{noteLabel(midi)}</option>)}</select></label>
            <label className="space-y-1 text-xs text-muted-foreground">最高音<select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={rule.toMidi} onChange={event => updateRule(rule.id, { toMidi: Number(event.target.value) })}>{noteOptions.map(midi => <option key={midi} value={midi}>{noteLabel(midi)}</option>)}</select></label>
            <label className="space-y-1 text-xs text-muted-foreground">颜色形式<Select value={rule.mode} onValueChange={value => updateRule(rule.id, { mode: value as PitchColorRule['mode'] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="solid">统一颜色</SelectItem><SelectItem value="linear">线性渐变</SelectItem></SelectContent></Select></label>
            <label className="flex items-end gap-2 pb-2 text-xs text-muted-foreground"><input type="checkbox" checked={rule.includeEnd} onChange={event => updateRule(rule.id, { includeEnd: event.target.checked })} className="size-4 accent-primary" />包含最高音</label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">{rule.mode === 'solid' ? '统一颜色' : '低音端颜色'}<Input type="color" value={rule.lowColor} onChange={event => updateRule(rule.id, { lowColor: event.target.value })} /></label>
            {rule.mode === 'linear' && <label className="space-y-1 text-xs text-muted-foreground">高音端颜色<Input type="color" value={rule.highColor} onChange={event => updateRule(rule.id, { highColor: event.target.value })} /></label>}
          </div>
          {rule.fromMidi >= rule.toMidi && <p className="text-xs text-destructive">最低音必须低于最高音；此区间在修正前不会生效。</p>}
        </div>)}
        <label className="block space-y-1 text-xs text-muted-foreground">未覆盖的音高<Select value={style.rangeFallback ?? 'base'} onValueChange={value => onChange({ ...style, rangeFallback: value as SubtitleStyle['rangeFallback'] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="base">普通文字颜色</SelectItem><SelectItem value="rainbow">彩虹色带</SelectItem><SelectItem value="cool">冷色带</SelectItem><SelectItem value="warm">暖色带</SelectItem></SelectContent></Select></label>
      </section>}

      <section className="space-y-2">
        <p className="text-sm font-medium">逐音预览</p>
        <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-10">{previewNotes.map(midi => <div key={midi} className="overflow-hidden rounded border border-border bg-background text-center text-[10px]"><div className="h-5" style={{ backgroundColor: pitchColor(440 * 2 ** ((midi - 69) / 12), style) }} /><span>{noteLabel(midi)}</span></div>)}</div>
        <p className="text-[11px] text-muted-foreground">预览显示整数音符；视频中会按实际 F0 在渐变区间内平滑取色。</p>
      </section>
      <DialogFooter><Button type="button" onClick={() => onOpenChange(false)}>完成</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
