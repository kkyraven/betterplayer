export type VrRoute = 'vd' | 'alvr' | 'frame' | 'steamlink' | 'metalink' | 'lighthouse' | 'unknown'

export interface VrHeadsetNames {
  driver: string
  model: string
}

export function vrRoute({ driver, model }: VrHeadsetNames): VrRoute {
  switch (driver.trim().toLowerCase()) {
    case 'oculus_virtualdesktop':
      return 'vd'
    case 'alvr_server':
      return 'alvr'
    case 'vrlink':
      return /steam frame/i.test(model) ? 'frame' : 'steamlink'
    case 'oculus':
      return 'metalink'
    case 'lighthouse':
      return 'lighthouse'
    default:
      return 'unknown'
  }
}

export const routeKeys = (route: VrRoute): boolean => route === 'vd' || route === 'alvr' || route === 'frame'
