import { defaultAdvancedPain } from '@shared/dom-pain'
import { describe, expect, it } from 'vitest'
import { defaultPleasurePain, emptyYou, newDom, type PleasurePain } from '@shared/dom'
import { domSystemPrompt, domTools, resolvePersona } from './prompt'

const names = (dom: ReturnType<typeof newDom>, pp: PleasurePain) => domTools(dom, pp).map((t) => t.function.name)

describe('the dom prompt', () => {
  it('offers the level and pictures only when they are set up', () => {
    const dom = newDom('a', 0, 'Vale')
    const off = defaultPleasurePain()
    expect(names(dom, off)).not.toContain('set_level')
    expect(names(dom, off)).not.toContain('send_image')
    const on = { ...dom, images: { ...dom.images, provider: 'comfyui' as const } }
    expect(names(on, { ...off, enabled: true })).toEqual(expect.arrayContaining(['set_level', 'send_image']))
  })

  it('offers sensation control without pleasure and pain and requires timestamp ranges in the queue', () => {
    const tools = domTools(newDom('a', 0), defaultPleasurePain())
    expect(tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(['stop_sensation', 'start_sensation', 'get_playback_state']))
    expect(tools.find((tool) => tool.function.name === 'queue_video')?.function.parameters.required).toEqual(['id', 'start_seconds', 'end_seconds'])
  })

  it('offers video tag access only after a global opt-in', () => {
    const dom = newDom('a', 0)
    expect(names(dom, defaultPleasurePain())).not.toContain('video_tags')
    expect(domTools(dom, defaultPleasurePain(), { tagEditing: true }).map((tool) => tool.function.name)).toContain('video_tags')
  })

  it('offers view_video only with an independent global opt-in', () => {
    const dom = newDom('a', 0)
    expect(domTools(dom, defaultPleasurePain(), { tagEditing: true }).map((tool) => tool.function.name)).not.toContain('view_video')
    expect(domTools(dom, defaultPleasurePain(), { viewVideo: true }).map((tool) => tool.function.name)).toContain('view_video')
  })

  it('advertises only configured pain profiles after the global opt-in', () => {
    const dom = newDom('a', 0)
    const pain = defaultAdvancedPain()
    expect(domTools(dom, defaultPleasurePain(), undefined, pain).map((tool) => tool.function.name)).not.toContain('apply_pain')
    pain.enabled = true
    pain.profiles[0]!.id = 'custom'
    const tools = domTools(dom, defaultPleasurePain(), undefined, pain)
    const parameters = tools.find((tool) => tool.function.name === 'apply_pain')?.function.parameters
    expect(parameters).toMatchObject({ properties: { profile: { enum: ['custom'] }, intensity: { minimum: 0, maximum: 10 } }, required: ['profile', 'intensity', 'seconds'] })
    expect(tools.map((tool) => tool.function.name)).toContain('stop_pain')
  })

  it('tells every dom who the user is and what is off limits', () => {
    const you = { ...emptyYou(), name: 'Lucy', petNames: ['pet'], limits: ['no humiliation'] }
    const prompt = domSystemPrompt({ ...newDom('a', 0, 'Vale'), persona: 'Vale watches {player} closely.' }, defaultPleasurePain(), you, ['SR6'], [])
    expect(prompt).toContain('Their name is Lucy.')
    expect(prompt).toContain('pet')
    expect(prompt).toContain('no humiliation')
    expect(prompt).toContain('Vale watches Lucy closely.')
  })
})

describe('resolvePersona', () => {
  const you = { ...emptyYou(), name: 'Lucy', pronouns: 'she/her', genitals: 'cock' }
  it('reads an Agentic Lover persona the way Agentic Lover does', () => {
    const text = 'You want {player} to call you: Mistress.\n\n[nsfw_only]\nYou like to do to {player}: Teasing.\n[/nsfw_only]\n\n[onboard_prompt]Ask their name.[/onboard_prompt]\n[regular_prompt]Welcome {pronoun.object} back.[/regular_prompt]'
    expect(resolvePersona(text, { name: 'Laura' }, you)).toBe('You want Lucy to call you: Mistress.\n\nYou like to do to Lucy: Teasing.\n\nWelcome her back.')
  })
  it('fills the dom, genitals and pronoun macros and leaves unknown ones alone', () => {
    expect(resolvePersona('{char} owns {{genitals}}; {pronoun.possessiveProper} is {mood}', { name: 'Laura' }, you)).toBe('Laura owns cock; hers is {mood}')
    expect(resolvePersona('{pronoun.subject}', { name: '' }, emptyYou())).toBe('they')
  })
})

it('adds the requested safeword instruction with the user subject pronoun only when configured', () => {
  const prompt = (safeword: string) => domSystemPrompt(newDom('a', 0), defaultPleasurePain(), { ...emptyYou(), pronouns: 'she/her', safeword }, [], [])
  expect(prompt('red')).toContain('Always honor the safeword by pausing the video and stopping, when she says the word "red". "red" is the safeword.')
  expect(prompt('')).not.toContain('Always honor the safeword')
})
