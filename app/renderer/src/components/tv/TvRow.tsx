import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from '@/lib/cx'
import { stepIndex, stepNumber, type NumberRange } from './rowStep'
import './tv.css'

interface Base {
  label: string
  sub?: string
  disabled?: boolean
  focusKey?: string
  navFirst?: boolean
  className?: string
}

interface SwitchRow extends Base {
  kind: 'switch'
  value: boolean
  onChange: (value: boolean) => void
}

interface OptionsRow<T extends string | number> extends Base {
  kind: 'options'
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  wrap?: boolean
}

interface NumberRow extends Base, NumberRange {
  kind: 'number'
  value: number
  holdStep?: number
  format: (value: number) => string
  onChange: (value: number) => void
}

interface ButtonRow extends Base {
  kind: 'button'
  action?: ReactNode
  onPress: () => void
}

export type TvRowProps<T extends string | number = string> = SwitchRow | OptionsRow<T> | NumberRow | ButtonRow

const HOLD_AFTER = 5

export function TvRow<T extends string | number>(props: TvRowProps<T>) {
  const repeats = useRef(0)

  const step = (delta: 1 | -1, held: boolean) => {
    if (props.disabled) return
    switch (props.kind) {
      case 'switch':
        props.onChange(delta > 0)
        break
      case 'options': {
        const i = props.options.findIndex((o) => o.value === props.value)
        const next = props.options[stepIndex(i, delta, props.options.length, props.wrap ?? false)]
        if (next && next.value !== props.value) props.onChange(next.value)
        break
      }
      case 'number': {
        const size = held && props.holdStep ? props.holdStep : 1
        const next = stepNumber(props.value, delta * size, props)
        if (next !== props.value) props.onChange(next)
        break
      }
      case 'button':
        break
    }
  }
  const activate = () => {
    if (props.disabled) return
    if (props.kind === 'switch') props.onChange(!props.value)
    else if (props.kind === 'button') props.onPress()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      repeats.current = e.repeat ? repeats.current + 1 : 0
      step(e.key === 'ArrowRight' ? 1 : -1, repeats.current >= HOLD_AFTER)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate()
    }
  }

  const stepper = props.kind === 'options' || props.kind === 'number'
  return (
    <div
      className={cx('tvrow', props.disabled && 'dim', props.className)}
      tabIndex={props.disabled ? -1 : 0}
      role={props.kind === 'switch' ? 'switch' : props.kind === 'button' ? 'button' : 'spinbutton'}
      aria-checked={props.kind === 'switch' ? props.value : undefined}
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
      data-nav-horizontal={stepper ? '' : undefined}
      data-focus-key={props.focusKey}
      data-nav-first={props.navFirst ? '' : undefined}
      onKeyDown={onKey}
      onClick={props.kind === 'switch' || props.kind === 'button' ? activate : undefined}
    >
      <div className="l">
        <b>{props.label}</b>
        {props.sub && <small>{props.sub}</small>}
      </div>
      <div className="v">
        {props.kind === 'switch' && <span className={cx('sw', props.value && 'on')} />}
        {props.kind === 'options' && (
          <>
            <ChevronLeft onClick={() => step(-1, false)} />
            <span>{props.options.find((o) => o.value === props.value)?.label ?? String(props.value)}</span>
            <ChevronRight onClick={() => step(1, false)} />
          </>
        )}
        {props.kind === 'number' && (
          <>
            <ChevronLeft onClick={() => step(-1, false)} />
            <span>{props.format(props.value)}</span>
            <ChevronRight onClick={() => step(1, false)} />
          </>
        )}
        {props.kind === 'button' && props.action !== undefined && <span className="act">{props.action}</span>}
      </div>
    </div>
  )
}
