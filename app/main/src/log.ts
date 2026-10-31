import { app, clipboard } from 'electron'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_TAIL_BYTES = 16 * 1024

const logPath = () => join(app.getPath('userData'), 'logs', 'process-errors.log')

export function logEvent(record: Record<string, unknown>) {
  const line = JSON.stringify({ time: new Date().toISOString(), version: app.getVersion(), ...record })
  try {
    process.stderr.write(`${line}\n`)
    mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true })
    appendFileSync(logPath(), `${line}\n`)
  } catch (error) {
    console.error('Could not write process event log', error)
  }
}

function logTail() {
  try {
    const path = logPath()
    const { size } = statSync(path)
    const start = Math.max(0, size - DEBUG_TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buffer, 0, buffer.length, start)
    } finally {
      closeSync(fd)
    }
    const text = buffer.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  }
}

export function copyDebugInfo() {
  clipboard.writeText([
    `Better Player ${app.getVersion()}${app.isPackaged ? '' : ' (dev)'}`,
    `${process.platform} ${process.getSystemVersion()} ${process.arch}`,
    `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}`,
    '',
    logTail().trimEnd() || 'process-errors.log is empty',
  ].join('\n'))
}
