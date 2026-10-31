import { createSocket, type Socket } from 'node:dgram'
import { QUEST_DISCOVERY_PROBE, type QuestBeacon } from '@shared/quest'

export function isProbe(message: Buffer): boolean {
  return message.toString('latin1').trim() === QUEST_DISCOVERY_PROBE
}

export function answerProbes(port: number, beacon: () => QuestBeacon): Socket {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  socket.on('message', (message, from) => {
    if (!isProbe(message)) return
    socket.send(JSON.stringify(beacon()), from.port, from.address)
  })
  socket.on('error', (e) => process.stderr.write(`quest discovery on ${port}: ${String(e)}\n`))
  socket.bind(port, '0.0.0.0')
  return socket
}
