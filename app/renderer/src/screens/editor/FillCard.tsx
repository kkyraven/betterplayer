import { WandSparkles, X } from 'lucide-react'
import { paceFromSlider, paceToSlider } from '@shared/tracking'
import { Button } from '@/components/ui/Button'
import { NumberInput } from '@/components/ui/NumberInput'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { keyLabel } from '@/input/actions'
import { AI_SOURCE_LABEL, useEditor, type AiSource } from '@/state/editor'
import { useT } from '@/state/i18n'
import { useTracking } from '@/state/tracking'

export function FillCard() {
  const t = useT()
  const sources = (Object.keys(AI_SOURCE_LABEL) as AiSource[]).map((value) => ({ value, label: t(AI_SOURCE_LABEL[value]) }))
  const ai = useEditor((s) => s.ai)
  const setAi = useEditor((s) => s.setAi)
  const setCard = useEditor((s) => s.setCard)
  const aiFill = useEditor((s) => s.aiFill)
  const analysing = useEditor((s) => s.analysing)
  const pace = useTracking((s) => s.pace)
  const setPace = useTracking((s) => s.setPace)
  const heroZone = useTracking((s) => s.heroZone)
  const blocked = ai.source === 'hero' && !heroZone
  return (
    <>
      <div className="ed-card-hd">
        <WandSparkles />
        <h2>{t('editor.fill.title')}</h2>
        <kbd>{keyLabel('Editor.AiFill.Card')}</kbd>
        <button type="button" className="ed-btn" aria-label={t('common.close')} title={t('common.close')} onClick={() => setCard(null)}>
          <X />
        </button>
      </div>
      <div className="ed-fields">
        <label className="ed-field">
          <span>{t('editor.fill.source')}</span>
          <Select options={sources} value={ai.source} label={t('editor.fill.source')} onChange={(source) => setAi({ source })} />
        </label>
        {ai.source === 'hero' && !heroZone && <p className="ed-hint">{t('editor.fill.heroZoneHint')}</p>}
        {ai.source !== 'beat' && ai.source !== 'hero' && (
          <div className="ed-field">
            <span>{t('editor.fill.region')}</span>
            <Segmented
              label={t('editor.fill.region')}
              value={ai.picking || ai.region ? 'pick' : 'auto'}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'pick', label: t('editor.fill.pickRegion') },
              ]}
              onChange={(v) => setAi(v === 'pick' ? { picking: true, region: ai.region ?? { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } } : { picking: false, region: null })}
            />
          </div>
        )}
        {ai.source === 'ai-motion' && (
          <div className="ed-field">
            <span>{t('editor.fill.pace')}</span>
            <Slider value={[paceToSlider(pace)]} label={t('editor.fill.pace')} onValueChange={(v) => setPace(paceFromSlider(v[0] ?? 50))} />
            <output>{Math.round(pace * 100)}</output>
          </div>
        )}
        <div className="ed-field">
          <span>{t('editor.fill.depth')}</span>
          <NumberInput value={ai.min} min={0} max={99} label={t('editor.fill.depthMin')} onChange={(min) => setAi({ min: Math.min(min, ai.max - 1) })} />
          <span className="val">{t('editor.fill.to')}</span>
          <NumberInput value={ai.max} min={1} max={100} label={t('editor.fill.depthMax')} onChange={(max) => setAi({ max: Math.max(max, ai.min + 1) })} />
        </div>
      </div>
      <p className="ed-hint">{t('editor.fill.hint')}</p>
      <div className="ed-card-foot">
        <span className="grow" />
        <Button variant="primary" disabled={analysing || blocked} onClick={() => void aiFill()}>
          {t(analysing ? 'editor.fill.analysing' : 'editor.fill.fill')} <kbd>{keyLabel('Editor.AiFill')}</kbd>
        </Button>
      </div>
    </>
  )
}
