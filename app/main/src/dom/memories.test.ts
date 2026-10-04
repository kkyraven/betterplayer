import { describe, expect, it } from 'vitest'
import { DOM_MEMORY_KINDS } from '@shared/dom'
import { fromAl, toAl } from './memories'

describe('memories in Agentic Lover', () => {
  it('comes back as the kind it went in as', () => {
    for (const kind of DOM_MEMORY_KINDS) {
      const al = toAl(kind, 'being told to count')
      expect(fromAl({ id: 7, memory_kind: al.kind, content: al.content })).toMatchObject({ id: '7', kind, content: 'being told to count' })
    }
  })

  it('reads memories Agentic Lover made itself', () => {
    expect(fromAl({ id: 'a', memory_kind: 'preference', content: 'Red lipstick' }).kind).toBe('like')
    expect(fromAl({ id: 'b', memory_kind: 'fact', content: 'Works nights' }).kind).toBe('reaction')
  })
})
