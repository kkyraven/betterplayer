import { describe, expect, it } from 'vitest'
import { routeKeys, vrRoute } from './vrRoute'

describe('vrRoute', () => {
  it('maps each streamer driver to its route', () => {
    expect(vrRoute({ driver: 'oculus_virtualdesktop', model: 'Oculus Quest 3' })).toBe('vd')
    expect(vrRoute({ driver: 'alvr_server', model: 'Quest 3' })).toBe('alvr')
    expect(vrRoute({ driver: 'oculus', model: 'Oculus Quest 3' })).toBe('metalink')
    expect(vrRoute({ driver: 'lighthouse', model: 'Index' })).toBe('lighthouse')
  })

  it('tells the Frame from Steam Link by the model', () => {
    expect(vrRoute({ driver: 'vrlink', model: 'Steam Frame' })).toBe('frame')
    expect(vrRoute({ driver: 'vrlink', model: 'Oculus Quest 3' })).toBe('steamlink')
  })

  it('reads an empty or unheard-of driver as unknown', () => {
    expect(vrRoute({ driver: '', model: '' })).toBe('unknown')
    expect(vrRoute({ driver: 'pimax', model: 'Crystal' })).toBe('unknown')
  })

  it('keys only where the streamer can', () => {
    expect((['vd', 'alvr', 'frame'] as const).every(routeKeys)).toBe(true)
    expect((['steamlink', 'metalink', 'lighthouse', 'unknown'] as const).some(routeKeys)).toBe(false)
  })
})
