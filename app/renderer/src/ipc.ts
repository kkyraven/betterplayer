import type { IpcRendererEvent } from 'electron'
import type { IpcChannel, IpcContract, IpcEvent, IpcEvents } from '@shared/ipc'
import { electron } from './node'

export function invoke<C extends IpcChannel>(
  channel: C,
  ...args: Parameters<IpcContract[C]>
): Promise<Awaited<ReturnType<IpcContract[C]>>> {
  return electron.ipcRenderer.invoke(channel, ...args)
}

export function on<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: IpcEvents[E]) => listener(payload)
  electron.ipcRenderer.on(event, wrapped)
  return () => {
    electron.ipcRenderer.off(event, wrapped)
  }
}
