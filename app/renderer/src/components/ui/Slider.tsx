import { useT } from '@/state/i18n'
import * as RadixSlider from '@radix-ui/react-slider'
import './Slider.css'

interface Props {
  value: number[]
  onValueChange: (value: number[]) => void
  onValueCommit?: (value: number[]) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  label: string
  thumbTitle?: (value: number) => string
}

export function Slider({ value, label, min = 0, max = 100, step = 1, thumbTitle, ...rest }: Props) {
  const t = useT()
  return (
    <RadixSlider.Root className="slider" value={value} min={min} max={max} step={step} minStepsBetweenThumbs={value.length > 1 ? 1 : 0} {...rest}>
      <RadixSlider.Track className="slider-track">
        <RadixSlider.Range className="slider-range" />
      </RadixSlider.Track>
      {value.map((v, i) => (
        <RadixSlider.Thumb key={i} className="slider-thumb" aria-label={value.length > 1 ? t(i === 0 ? 'common.minimumLabel' : 'common.maximumLabel', { label }) : label} title={thumbTitle?.(v)} aria-valuetext={thumbTitle?.(v)} />
      ))}
    </RadixSlider.Root>
  )
}
