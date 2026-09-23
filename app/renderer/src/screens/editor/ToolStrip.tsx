import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowUpDown, Bookmark, Check, CircleDot, Clapperboard, Ellipsis, FileText, Flag, Keyboard, Layers, Magnet, MousePointer2, MoveVertical, Plus, Repeat2, Scan, SlidersHorizontal, WandSparkles, Waves, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ACTIONS, keyLabel, runAction, type ActionId } from '@/input/actions'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { useEditor } from '@/state/editor'

function Tool({ id, icon: Icon, on = false }: { id: ActionId; icon: LucideIcon; on?: boolean }) {
  const t = useT()
  const key = keyLabel(id)
  const label = t(ACTIONS[id].label)
  return (
    <button type="button" className={cx('ed-btn', on && 'on')} title={key ? `${label} (${key})` : label} aria-label={label} aria-pressed={on || undefined} onClick={() => runAction(id)}>
      <Icon />
    </button>
  )
}

function MenuItem({ id }: { id: ActionId }) {
  const t = useT()
  const key = keyLabel(id)
  return (
    <DropdownMenu.Item className="item" onSelect={() => runAction(id)}>
      {t(ACTIONS[id].label)}
      {key && <span className="right">{key}</span>}
    </DropdownMenu.Item>
  )
}

function Menu({ label, icon: Icon, children, on = false }: { label: string; icon: LucideIcon; children: ReactNode; on?: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={cx('ed-btn', on && 'on')} title={label} aria-label={label}>
          <Icon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" side="right" align="start" sideOffset={8}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Check_({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <DropdownMenu.CheckboxItem className="item" checked={checked} onCheckedChange={onChange}>
      <span className="tick">
        <DropdownMenu.ItemIndicator>
          <Check />
        </DropdownMenu.ItemIndicator>
      </span>
      {label}
    </DropdownMenu.CheckboxItem>
  )
}

export function ToolStrip() {
  const t = useT()
  const tool = useEditor((s) => s.tool)
  const card = useEditor((s) => s.card)
  const recording = useEditor((s) => s.recording)
  const snap = useEditor((s) => s.snap)
  const trace = useEditor((s) => s.trace)
  const filmstrip = useEditor((s) => s.filmstrip)
  const waveform = useEditor((s) => s.waveform)
  const beatGrid = useEditor((s) => s.beatGrid)
  const centre = useEditor((s) => s.view.centre)
  const linked = useEditor((s) => s.linked)
  const setOption = useEditor((s) => s.setOption)
  const toggleLinked = useEditor((s) => s.toggleLinked)
  return (
    <div className="ed-tools" aria-label={t('editor.toolStrip.tools')}>
      <div className="group">
        <Tool id="Editor.Tool.Select" icon={MousePointer2} on={tool === 'select'} />
        <Tool id="Editor.Tool.Place" icon={Plus} on={tool === 'place'} />
        <Tool id="Editor.Record" icon={CircleDot} on={card === 'record' || recording} />
      </div>
      <span className="ed-sep" />
      <div className="group">
        <Tool id="Editor.ScaleDepth" icon={MoveVertical} on={card === 'scaleDepth'} />
        <Tool id="Editor.Invert" icon={ArrowUpDown} />
        <Tool id="Editor.Simplify" icon={Waves} on={card === 'simplify'} />
        <Menu label={t('editor.toolStrip.moreEditTools')} icon={Ellipsis} on={card === 'scaleTime' || card === 'rangeExtend' || card === 'loop' || card === 'quantise' || card === 'limitSpeed' || card === 'selectBy'}>
          <MenuItem id="Editor.Reverse" />
          <MenuItem id="Editor.Flatten" />
          <MenuItem id="Editor.ScaleTime" />
          <MenuItem id="Editor.RangeExtend" />
          <MenuItem id="Editor.Loop" />
          <MenuItem id="Editor.Quantise" />
          <MenuItem id="Editor.LimitSpeed" />
          <DropdownMenu.Separator className="sep" />
          <MenuItem id="Editor.Select.By" />
          <MenuItem id="Editor.Select.Tops" />
          <MenuItem id="Editor.Select.Bottoms" />
          <MenuItem id="Editor.Select.Mids" />
          <MenuItem id="Editor.Select.BetweenCuts" />
          <MenuItem id="Editor.Select.Chapter" />
          <MenuItem id="Editor.Select.Invert" />
        </Menu>
      </div>
      <span className="ed-sep" />
      <div className="group">
        <Tool id="Editor.Fill.Card" icon={Repeat2} on={card === 'pattern'} />
        <Tool id="Editor.AiFill.Card" icon={WandSparkles} on={card === 'fill'} />
        <Tool id="Editor.Refit" icon={Scan} />
        <Tool id="Editor.OtherAxes" icon={Layers} />
      </div>
      <span className="ed-sep" />
      <div className="group">
        <Tool id="Editor.Bookmark" icon={Bookmark} />
        <Tool id="Editor.Flag.Toggle" icon={Flag} />
        <Tool id="Editor.Chapter.Start" icon={Clapperboard} />
        <Tool id="Editor.Metadata" icon={FileText} />
      </div>
      <span className="grow" />
      <Tool id="Editor.Snap.Toggle" icon={Magnet} on={snap} />
      <Menu label={t('editor.toolStrip.view')} icon={SlidersHorizontal}>
        <Check_ label={t('editor.toolStrip.motionTrace')} checked={trace} onChange={(on) => setOption('trace', on)} />
        <Check_ label={t('editor.toolStrip.filmstrip')} checked={filmstrip} onChange={(on) => setOption('filmstrip', on)} />
        <Check_ label={t('editor.toolStrip.waveform')} checked={waveform} onChange={(on) => setOption('waveform', on)} />
        <Check_ label={t('editor.toolStrip.beatGrid')} checked={beatGrid} onChange={(on) => setOption('beatGrid', on)} />
        <Check_ label={t('editor.toolStrip.playheadAtCentre')} checked={centre} onChange={(on) => setOption('centre', on)} />
        <DropdownMenu.Separator className="sep" />
        <Check_ label={t('editor.toolStrip.linkedLanes')} checked={linked} onChange={toggleLinked} />
      </Menu>
      <Tool id="Editor.Shortcuts" icon={Keyboard} />
    </div>
  )
}
