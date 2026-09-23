import { describe, expect, it } from 'vitest'
import { parseReleaseNotes } from './update'

describe('parseReleaseNotes', () => {
  it('reads each version heading with its bullets, in file order', () => {
    const md = ['# Release notes', '', 'Written by hand.', '', '## 0.4.1', '', '- Linux Builds Fix', '', '## 0.4.0', '- Fix frames', '- Improve session', ''].join('\n')
    expect(parseReleaseNotes(md)).toEqual([
      { version: '0.4.1', notes: ['Linux Builds Fix'] },
      { version: '0.4.0', notes: ['Fix frames', 'Improve session'] },
    ])
  })
  it('drops versions with no bullets and ignores bullets before the first heading', () => {
    expect(parseReleaseNotes('- stray\n## 0.2.0\n\n## 0.1.0\n- First')).toEqual([{ version: '0.1.0', notes: ['First'] }])
  })
})
