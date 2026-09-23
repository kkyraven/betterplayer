import { Play, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { TvRow } from '@/components/tv/TvRow'
import { outputName, testMove, useDevices, type ConfiguredOutput } from '@/state/devices'
import { useT } from '@/state/i18n'

export function DevicesGroup() {
  const t = useT()
  const outputs = useDevices((s) => s.outputs)
  return (
    <>
      {outputs.map((o, i) => (
        <DeviceRows key={o.id} output={o} first={i === 0} />
      ))}
      <TvRow kind="button" label={outputs.length === 0 ? t('tv.devices.noDevices') : t('tv.devices.moreDevices')} sub={t('tv.devices.addOnDesktop')} navFirst={outputs.length === 0} disabled onPress={() => undefined} />
    </>
  )
}

function DeviceRows({ output, first }: { output: ConfiguredOutput; first: boolean }) {
  const t = useT()
  const state = useDevices((s) => s.states[output.id])
  const reconnect = useDevices((s) => s.reconnect)
  const [testing, setTesting] = useState(false)
  const name = outputName(output.config)
  const status = state?.status === 'connected' ? t('tv.devices.connected') : state?.status === 'connecting' ? t('tv.devices.connecting') : (state?.error ?? t('tv.devices.notConnected'))
  const battery = state?.battery !== undefined ? ` · ${t('tv.devices.battery', { value: Math.round(state.battery) })}` : ''
  return (
    <>
      <TvRow
        kind="button"
        label={name}
        sub={status + battery}
        navFirst={first}
        action={
          <>
            <RefreshCw />
            {t('tv.devices.reconnect')}
          </>
        }
        onPress={() => reconnect(output.id)}
      />
      <TvRow
        kind="button"
        label={t('tv.devices.test', { name })}
        sub={(output.config.kind === 'openshock' || output.config.kind === 'pishock') ? (testing ? t('tv.devices.pulsing') : t('tv.devices.onePulse')) : testing ? t('tv.devices.moving') : t('tv.devices.oneSweep')}
        disabled={state?.status !== 'connected' || testing}
        action={
          <>
            <Play />
            {t('tv.devices.testButton')}
          </>
        }
        onPress={() => {
          setTesting(true)
          void testMove(output).finally(() => setTesting(false))
        }}
      />
    </>
  )
}
