const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSocket } = require('node:dgram')
const { setTimeout: delay } = require('node:timers/promises')
const { Engine } = require('..')

test('Restim sends only configured carrier and pulse parameters', async () => {
  const receiver = createSocket('udp4')
  const commands = []
  const parameters = ['C0', 'P0', 'P1', 'P2', 'P3']
  const parameterCommands = () => commands.filter((c) => parameters.includes(c.slice(0, 2)))
  receiver.on('message', (message) => commands.push(...message.toString().trim().split(/\s+/)))
  const until = async (check) => {
    const deadline = Date.now() + 3000
    while (!check()) {
      assert.ok(Date.now() < deadline, 'expected output was not received')
      await delay(10)
    }
  }
  let engine
  try {
    await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve))
    engine = new Engine(2, 2, Array.from({ length: 3 }, () => new Uint8Array(16)))
    engine.setPresenting(false)
    engine.connect({ kind: 'udp', host: '127.0.0.1', port: receiver.address().port, profile: 'restim' })
    await until(() => commands.some((c) => c.startsWith('V0')))
    await delay(100)
    assert.deepEqual(parameterCommands(), [], 'connecting does not send parameter defaults')
    const sent = () => engine.state().outputs.find((o) => o.profile === 'restim').sentValues
    assert.equal(sent().EV, 0, 'the preview reports the final mute command')
    assert.ok(parameters.every((axis) => sent()[axis] === undefined), 'unsent parameters have no preview value')

    engine.setEstim({ ...engine.estim(), params: true })
    await delay(100)
    assert.deepEqual(parameterCommands(), [], 'enabling parameters alone does not configure any axis')

    for (const axis of parameters) {
      commands.length = 0
      engine.setParamSource(axis, { source: 'fixed', value: 0.5 })
      await until(() => commands.some((c) => c.startsWith(`${axis}5000I`)))
      assert.equal(sent()[axis], 5000 / 9999, 'the preview uses the encoded value')
      assert.ok(parameterCommands().every((c) => c.startsWith(axis)), 'other parameters stay silent')

      engine.setParamSource(axis, { source: 'restim' })
      await delay(100)
      assert.ok(parameterCommands().every((c) => c.startsWith(`${axis}5000I`)), 'returning control does not send a reset value')
      commands.length = 0
      await delay(100)
      assert.deepEqual(parameterCommands(), [], 'restim retains control after clearing the source')
      assert.equal(sent()[axis], 5000 / 9999, 'the last sent value remains visible this session')
    }
  } finally {
    engine?.close()
    receiver.close()
  }
})
