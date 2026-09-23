export interface OpenShockShocker {
  id: string
  name: string
  hub: string
  model: string | null
  paused: boolean
}

export interface OpenShockOwnJson {
  data: Array<{
    id: string
    name: string
    shockers: Array<{ id: string; name: string; model?: string | null; isPaused?: boolean }>
  }>
}

export function readShockers(json: OpenShockOwnJson): OpenShockShocker[] {
  return (json.data ?? []).flatMap((hub) => (hub.shockers ?? []).map((s) => ({ id: s.id, name: s.name, hub: hub.name, model: s.model ?? null, paused: s.isPaused === true })))
}
