import { monitorEventLoopDelay } from 'node:perf_hooks'

type Metric = 'metadata' | 'asset' | 'conversion' | 'database'
const enabled = process.env.BP_STASH_DIAGNOSTICS === '1'
const metrics = new Map<Metric, { count: number; total: number; max: number }>()

export function recordMetric(kind: Metric, durationMs: number) {
  if (!enabled) return
  const metric = metrics.get(kind) ?? { count: 0, total: 0, max: 0 }
  metric.count++
  metric.total += durationMs
  metric.max = Math.max(metric.max, durationMs)
  metrics.set(kind, metric)
}

if (enabled) {
  const loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()
  setInterval(() => {
    const counts = Object.fromEntries([...metrics].map(([kind, metric]) => [kind, { count: metric.count, total_ms: Math.round(metric.total), max_ms: Math.round(metric.max) }]))
    process.stderr.write(`stash maintenance ${JSON.stringify({ ...counts, loop_max_ms: Math.round(loop.max / 1e6) })}\n`)
    metrics.clear()
    loop.reset()
  }, 5000).unref()
}
