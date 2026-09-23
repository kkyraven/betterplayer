import { expect, it } from 'vitest'
import { defaultOpenShockTrigger } from '@shared/settings'
import { migrate } from './store'

it('defaults shockers to their dedicated script and preserves PiShock connections', () => {
  expect(defaultOpenShockTrigger().axis).toBe('S0')
  const config = {
    kind: 'pishock',
    profile: 'stroker',
    username: 'user',
    token: 'key',
    userId: 12,
    clientId: 34,
    shocker: '56',
    trigger: defaultOpenShockTrigger(),
  }
  expect(migrate({ version: 1, devices: { outputs: [config] } }).devices.outputs[0]).toMatchObject(config)
})
it('preserves an explicitly selected OpenShock axis', () => {
  const trigger = { ...defaultOpenShockTrigger(), axis: 'L1' }
  expect(migrate({ version: 1, devices: { outputs: [{ kind: 'openshock', trigger }] } }).devices.outputs[0]?.trigger).toEqual(trigger)
})
