import { useEffect } from 'react'
import type { EstimAudioDevice } from 'bp-engine'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { useDevices, type ConfiguredOutput } from '@/state/devices'
import { useEstimAudio } from '@/state/estimAudio'
import { useT } from '@/state/i18n'

const READ_MS = 2000

export function useSoundOutputs(): EstimAudioDevice[] | null {
  const devices = useEstimAudio((s) => s.devices)
  useEffect(() => {
    const read = useEstimAudio.getState().readDevices
    read()
    const timer = window.setInterval(read, READ_MS)
    return () => window.clearInterval(timer)
  }, [])
  return devices
}

export function EstimAudioRows({ output }: { output: ConfiguredOutput }) {
  const t = useT()
  const setAudioDevice = useDevices((s) => s.setAudioDevice)
  const setVolume = useDevices((s) => s.setVolume)
  const devices = useSoundOutputs()
  const listed = devices ?? []
  const device = output.config.device ?? ''
  const label = output.config.label ?? device
  const away = !listed.some((d) => d.name === device)
  const options = [
    ...listed.map((d) => ({ value: d.name, label: d.description })),
    ...(away ? [{ value: device, label: devices ? t('estimAudio.missing', { name: label }) : label }] : []),
  ]
  const pick = (name: string) => {
    const picked = listed.find((d) => d.name === name)
    if (picked && name !== device) void setAudioDevice(output.id, { name: picked.name, label: picked.description })
  }
  const volume = Math.round((output.config.volume ?? 1) * 100)
  return (
    <>
      <div className="prow">
        <span className="lbl">{t('estimAudio.soundOutput')}</span>
        <span className="spacer" />
        <Select label={t('estimAudio.soundOutput')} value={device} options={options} onChange={pick} />
      </div>
      <div className="prow">
        <span className="lbl">{t('axis.EV')}</span>
        <div className="track-wrap strength">
          <Slider label={t('axis.EV')} value={[volume]} max={100} step={1} onValueChange={([v]) => setVolume(output.id, (v ?? 0) / 100)} />
        </div>
        <span className="val">{volume}%</span>
      </div>
    </>
  )
}
