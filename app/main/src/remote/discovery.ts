import { createSocket, type Socket } from 'node:dgram'
import { QUEST_DISCOVERY_PORT, QUEST_DISCOVERY_PROBE, QUEST_INVITE, type QuestBeacon, type QuestProbe } from '@shared/quest'
import { readProbe } from './pairing'

export function probeOf(message: Buffer): Required<QuestProbe> | null {
  const text = message.toString('utf8')
  return text.startsWith(QUEST_DISCOVERY_PROBE) ? readProbe(text.slice(QUEST_DISCOVERY_PROBE.length)) : null
}

export function answerProbes(port: number, beacon: (probe: Required<QuestProbe>, host: string, port: number) => QuestBeacon): Socket {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  socket.on('message', (message, from) => {
    const probe = probeOf(message)
    if (probe) socket.send(JSON.stringify(beacon(probe, from.address, from.port)), from.port, from.address)
  })
  socket.on('error', (e) => process.stderr.write(`quest discovery on ${port}: ${String(e)}\n`))
  socket.bind(port, '0.0.0.0')
  return socket
}

export function invite(socket: Socket, beacon: QuestBeacon, host: string, port: number) {
  socket.send(QUEST_INVITE + JSON.stringify(beacon), port, host)
}

export function nudge(socket: Socket, beacon: QuestBeacon, host: string) {
  socket.send(JSON.stringify(beacon), QUEST_DISCOVERY_PORT, host)
}
