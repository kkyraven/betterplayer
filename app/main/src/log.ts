import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function logEvent(record: Record<string, unknown>) {
  const line = JSON.stringify({ time: new Date().toISOString(), version: app.getVersion(), ...record })
  process.stderr.write(`${line}\n`)
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'process-errors.log'), `${line}\n`)
  } catch (error) {
    console.error('Could not write process event log', error)
  }
}
