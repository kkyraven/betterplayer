import { describe, expect, it } from 'vitest'
import { findArchivePasswords, type ArchivePasswordBlock, type ArchivePasswordSource } from './archive-passwords'

const zip: ArchivePasswordSource = { id: 'zip', kind: 'archive', fileName: 'test-pack.zip' }
const cloud: ArchivePasswordSource = { id: 'cloud', kind: 'unknown' }
const heading = (text: string, headingLevel: number): ArchivePasswordBlock => ({ text, kind: 'heading', headingLevel })
const text = (value: string, sourceIds?: string[]): ArchivePasswordBlock => ({ text: value, kind: 'text', sourceIds })

describe('findArchivePasswords', () => {
  it('keeps Script ancestry across peer provider headings and excludes the separate Video section', () => {
    const blocks = [
      heading('Video', 3), text('Video download', ['video-cloud']),
      heading('Script', 3), heading('Mega File Preview', 4), text('Preview'),
      heading('Direct Download', 4), heading('funscript_v1', 5), text('script.funscript', ['direct-script']),
      heading('funscript_v2', 5), text('alternate.funscript', ['alternate-script']),
      heading('Get from Pixeldrain', 4), text('ZIP onebox', ['cloud']),
      heading('Get from Patreon', 4), text('Creator subscription'),
      heading('Unzip Password', 4), text('ExampleArchiveToken'),
      heading('Subscribe to creator', 2), text('Password: NotAnArchiveToken'),
    ]
    const sources: ArchivePasswordSource[] = [cloud, { id: 'video-cloud', kind: 'unknown' }, { id: 'direct-script', kind: 'script' }, { id: 'alternate-script', kind: 'script' }]
    expect(findArchivePasswords({ blocks }, sources)).toEqual([{ sourceId: 'cloud', candidates: ['ExampleArchiveToken'] }])
  })

  it('reads the explicit inline Archive Password and following archive onebox', () => {
    expect(findArchivePasswords({ blocks: [text('Archive Password: ExampleInlineToken'), text('test-pack.zip', ['zip'])] }, [zip]))
      .toEqual([{ sourceId: 'zip', candidates: ['ExampleInlineToken'] }])
  })

  it('reads an adjacent PW code label without accepting generic provider or login PW', () => {
    const block = { ...text('PW: '), literalValue: '  ExampleToken  ' }
    expect(findArchivePasswords({ blocks: [block, text('test-pack.zip', ['zip'])] }, [zip]))
      .toEqual([{ sourceId: 'zip', candidates: ['  ExampleToken  '] }])
    expect(findArchivePasswords({ blocks: [block, text('Provider file', ['cloud'])] }, [cloud])).toEqual([])
    expect(findArchivePasswords({ blocks: [heading('Account login', 3), block, text('test-pack.zip', ['zip'])] }, [zip])).toEqual([])
    expect(findArchivePasswords({ blocks: [text('PW reset requested'), text('test-pack.zip', ['zip'])] }, [zip])).toEqual([])
  })

  it('supports a Password heading adjacent to an actual ZIP or Script section', () => {
    const blocks = [heading('Scripts', 3), text('Download', ['cloud']), heading('Password', 4), { text: 'two word token', kind: 'code' as const }]
    expect(findArchivePasswords({ blocks }, [cloud])).toEqual([{ sourceId: 'cloud', candidates: ['two word token'] }])
    expect(findArchivePasswords({ blocks: [text('test-pack.zip', ['zip']), heading('Password', 4), text('KnownZipToken')] }, [zip]))
      .toEqual([{ sourceId: 'zip', candidates: ['KnownZipToken'] }])
  })

  it('does not treat generic provider or login passwords as archive passwords', () => {
    const blocks = [heading('Mega login', 3), heading('Password', 4), text('NotAnArchiveToken'), text('File', ['cloud'])]
    expect(findArchivePasswords({ blocks }, [cloud])).toEqual([])
    expect(findArchivePasswords({ blocks: [heading('Pixeldrain', 3), heading('Password', 4), text('ProviderToken'), text('File', ['cloud'])] }, [cloud])).toEqual([])
    expect(findArchivePasswords({ blocks: [text('Login password: NotAnArchiveToken'), text('test-pack.zip', ['zip'])] }, [zip])).toEqual([])
  })

  it('ignores quoted, ad, and excluded values or links without crossing their boundary', () => {
    expect(findArchivePasswords({ blocks: [{ ...text('Archive Password: QuotedToken'), excluded: true }, text('ZIP', ['zip'])] }, [zip])).toEqual([])
    expect(findArchivePasswords({ blocks: [heading('Unzip Password', 4), { ...text('QuotedToken'), excluded: true }, text('ZIP', ['zip'])] }, [zip])).toEqual([])
    expect(findArchivePasswords({ blocks: [text('Archive Password: ExampleToken'), { ...text('ZIP', ['zip']), excluded: true }] }, [zip])).toEqual([])
  })

  it('binds distinct passwords to separate archive sections rather than all post files', () => {
    const second: ArchivePasswordSource = { id: 'second', kind: 'archive', fileName: 'second-pack.zip' }
    const blocks = [
      heading('Scripts', 2), heading('First archive', 3), text('test-pack.zip', ['zip']), heading('Unzip Password', 4), text('FirstToken'),
      heading('Second archive', 3), text('second-pack.zip', ['second']), heading('Unzip Password', 4), text('SecondToken'),
    ]
    expect(findArchivePasswords({ blocks }, [zip, second])).toEqual([{ sourceId: 'zip', candidates: ['FirstToken'] }, { sourceId: 'second', candidates: ['SecondToken'] }])
  })

  it('refuses ambiguous unrelated archives and allows explicit named or container associations', () => {
    const second: ArchivePasswordSource = { id: 'second', kind: 'archive', fileName: 'second-pack.zip' }
    const ambiguous = [text('ZIP files', ['zip', 'second']), text('Archive Password: UnscopedToken')]
    expect(findArchivePasswords({ blocks: ambiguous }, [zip, second])).toEqual([])
    expect(findArchivePasswords({ blocks: [text('ZIP files', ['zip', 'second']), text('Password for second-pack.zip: NamedToken')] }, [zip, second]))
      .toEqual([{ sourceId: 'second', candidates: ['NamedToken'] }])
    const explicit = [
      { ...text('ZIP', ['zip']), groupId: 'first' }, { ...text('Archive Password: FirstToken'), groupId: 'first' },
      { ...text('ZIP', ['second']), groupId: 'second' }, { ...text('Archive Password: SecondToken'), groupId: 'second' },
    ]
    expect(findArchivePasswords({ blocks: explicit }, [zip, second])).toEqual([{ sourceId: 'zip', candidates: ['FirstToken'] }, { sourceId: 'second', candidates: ['SecondToken'] }])
  })

  it('honors explicit source IDs and does not fall back after a nonarchive association', () => {
    const blocks = [text('ZIP', ['zip']), text('Archive Password: ScopedToken', ['cloud'])]
    expect(findArchivePasswords({ blocks }, [zip, cloud])).toEqual([{ sourceId: 'cloud', candidates: ['ScopedToken'] }])
    expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), text('Archive Password: WrongTargetToken', ['video'])] }, [zip, { id: 'video', kind: 'video' }])).toEqual([])
  })

  it('applies a password to verified mirrors without guessing from matching file names', () => {
    const mirror: ArchivePasswordSource = { id: 'mirror', kind: 'archive', fileName: 'test-pack.zip', mirrorKey: 'verified' }
    expect(findArchivePasswords({ blocks: [text('ZIP mirrors', ['zip', 'mirror']), text('Unzip Password: MirrorToken')] }, [{ ...zip, mirrorKey: 'verified' }, mirror]))
      .toEqual([{ sourceId: 'zip', candidates: ['MirrorToken'] }, { sourceId: 'mirror', candidates: ['MirrorToken'] }])
    expect(findArchivePasswords({ blocks: [text('ZIP files', ['zip', 'mirror']), text('Unzip Password: UnverifiedToken')] }, [zip, { ...mirror, mirrorKey: null }])).toEqual([])
    expect(findArchivePasswords({ blocks: [text('Files', ['cloud', 'other']), text('Unzip Password: AmbiguousToken')] }, [cloud, { id: 'other', kind: 'unknown' }])).toEqual([])
  })

  it('resolves an explicit my username instruction only for the same known post author and archive cue', () => {
    const blocks = [text('ZIP', ['zip']), text('Archive Password: my username')]
    expect(findArchivePasswords({ authorUsername: 'ExampleAuthor', blocks }, [zip])).toEqual([{ sourceId: 'zip', candidates: ['ExampleAuthor'] }])
    expect(findArchivePasswords({ blocks }, [zip])).toEqual([])
    expect(findArchivePasswords({ authorUsername: 'ExampleAuthor', blocks: [text('ZIP', ['zip']), text('Password: my username')] }, [zip])).toEqual([])
    expect(findArchivePasswords({ authorUsername: 'Other Author', blocks }, [zip])).toEqual([])
    expect(findArchivePasswords({ authorUsername: 'ExampleAuthor', blocks: [text('ZIP', ['zip'])] }, [zip])).toEqual([])
    expect(findArchivePasswords({ authorUsername: 'ExampleAuthor', blocks: [text('ZIP', ['zip']), text('Archive Password: "my username"')] }, [zip]))
      .toEqual([{ sourceId: 'zip', candidates: ['my username'] }])
  })

  it('preserves literal password case, Unicode, symbols, and spaces inside wrappers', () => {
    const blocks = [text('ZIP', ['zip']), text('Archive Password: "  Case ! 密碼  "')]
    expect(findArchivePasswords({ blocks }, [zip])).toEqual([{ sourceId: 'zip', candidates: ['  Case ! 密碼  '] }])
  })
  it('preserves explicit code literals and only removes code-block framing newlines', () => {
    for (const value of ['"token"', '`token`', '  token  ', 'my username']) {
      const blocks: ArchivePasswordBlock[] = [text('ZIP', ['zip']), heading('Archive Password', 4), { kind: 'code', text: value }]
      expect(findArchivePasswords({ authorUsername: 'OtherAuthor', blocks }, [zip])).toEqual([{ sourceId: 'zip', candidates: [value] }])
    }
    expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), heading('Archive Password', 4), { kind: 'code', text: '\n  token  \n' }] }, [zip]))
      .toEqual([{ sourceId: 'zip', candidates: ['  token  '] }])
  })
  it('reads an inline code value without treating additional prose as part of its password', () => {
    const blocks = [text('ZIP', ['zip']), { ...text('ZIP Password: '), literalValue: ' "token" ' }]
    expect(findArchivePasswords({ blocks }, [zip])).toEqual([{ sourceId: 'zip', candidates: [' "token" '] }])
    expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), { ...text('ZIP Password: contact author'), literalValue: 'token' }] }, [zip])).toEqual([])
  })

  it('rejects access instructions, URLs, control characters, and overlong candidates', () => {
    for (const value of ['Please subscribe to get the password', 'https://example.org/token', 'token\u0000tail', 'x'.repeat(257), 'not required']) {
      expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), text(`Archive Password: ${value}`)] }, [zip])).toEqual([])
    }
  })

  it('requires a complete Password label and an inline separator', () => {
    for (const value of ['Passwordless files', 'Password applies to all archives', 'Archive Password ExampleToken']) {
      expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), text(value)] }, [zip])).toEqual([])
    }
    expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), text('The ZIP password is ExampleToken')] }, [zip]))
      .toEqual([{ sourceId: 'zip', candidates: ['ExampleToken'] }])
  })

  it('does not cross separate content sections or use a distant generic Password label', () => {
    const blocks = [heading('Video', 3), heading('Unzip Password', 4), text('VideoToken'), heading('Script', 3), text('ZIP', ['zip'])]
    expect(findArchivePasswords({ blocks }, [zip])).toEqual([])
    expect(findArchivePasswords({ blocks: [heading('Script', 3), heading('Unzip Password', 4), text('ScriptToken'), heading('Other downloads', 3), text('ZIP', ['zip'])] }, [zip])).toEqual([])
    expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), ...Array.from({ length: 5 }, () => text('Unrelated paragraph')), heading('Password', 4), text('DistantToken')] }, [zip])).toEqual([])
  })

  it('allows a password for a known video ZIP while excluding ordinary video sources', () => {
    const blocks = [heading('Video', 3), text('test-pack.zip', ['zip']), text('Video', ['video']), heading('Password', 4), text('VideoZipToken')]
    expect(findArchivePasswords({ blocks }, [zip, { id: 'video', kind: 'video' }]))
      .toEqual([{ sourceId: 'zip', candidates: ['VideoZipToken'] }])
  })

  it('bounds post blocks and sources rather than scanning arbitrary appended content', () => {
    const blocks = [text('ZIP', ['zip']), ...Array.from({ length: 499 }, () => text('Ordinary text')), text('Archive Password: OutOfBoundsToken')]
    expect(findArchivePasswords({ blocks }, [zip])).toEqual([])
    const sources: ArchivePasswordSource[] = [...Array.from({ length: 200 }, (_, index) => ({ id: `source-${index}`, kind: 'archive' as const })), zip]
    expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), text('Archive Password: OutOfBoundsToken')] }, sources)).toEqual([])
  })

  it('bounds and deduplicates candidates without changing case or input data', () => {
    const blocks = [text('ZIP', ['zip']), ...Array.from({ length: 12 }, (_, index) => text(`Archive Password: ExampleToken${index}`)), text('Archive Password: ExampleToken0')]
    const original = structuredClone(blocks)
    expect(findArchivePasswords({ blocks }, [zip])).toEqual([{ sourceId: 'zip', candidates: Array.from({ length: 8 }, (_, index) => `ExampleToken${index}`) }])
    expect(blocks).toEqual(original)
    expect(findArchivePasswords({ blocks: [text('ZIP', ['zip']), text('Archive Password: TOKEN'), text('Archive Password: token')] }, [zip]))
      .toEqual([{ sourceId: 'zip', candidates: ['TOKEN', 'token'] }])
  })
})
