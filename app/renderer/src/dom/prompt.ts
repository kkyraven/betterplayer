// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { AdvancedPain } from '@shared/dom-pain'
import { DOM_LEVEL_MAX, DOM_MEMORY_KINDS, type DomAiSettings, type ChatTool, type DomMemory, type DomProfile, type DomYou, type PleasurePain } from '@shared/dom'

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ChatTool => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
})

export function domTools(dom: DomProfile, pp: PleasurePain, ai?: Partial<Pick<DomAiSettings, 'tagEditing' | 'viewVideo'>>, pain?: AdvancedPain): ChatTool[] {
  return [
    fn('top_videos', 'The 20 videos the user has watched most: id, title, minutes, duration_seconds and top tags.'),
    fn('search_videos', 'Searches the user\'s library by title, tag or performer. Up to 20 results.', { query: { type: 'string' } }, ['query']),
    fn('play_video', 'Starts a video or timestamp range now, replacing what plays. Times are absolute seconds in the video.', { id: { type: 'integer' }, start_seconds: { type: 'number', minimum: 0 }, end_seconds: { type: 'number', exclusiveMinimum: 0 } }, ['id']),
    fn('queue_video', 'Queues only the selected timestamp range, starting when the current video or range ends. Times are absolute seconds in the video; end_seconds must exceed start_seconds and stay within duration_seconds. The user is not told what is next.', { id: { type: 'integer' }, start_seconds: { type: 'number', minimum: 0 }, end_seconds: { type: 'number', exclusiveMinimum: 0 } }, ['id', 'start_seconds', 'end_seconds']),
    fn('get_playback_state', 'Reads the current video id, absolute position and duration in seconds, paused state, current timestamp range, queue and sensation state.'),
    fn('stop_sensation', 'Pauses estim and sex toy output while the video keeps playing. Automatically resumes after seconds, ramping back to the current configured output over 500 ms. Accepts fractional seconds up to 30.', { seconds: { type: 'number', exclusiveMinimum: 0, maximum: 30 } }, ['seconds']),
    fn('start_sensation', 'Ends a sensation pause early and ramps back to the current configured output over 500 ms. Does not resume a paused video.'),
    fn('playback', 'Controls the player.', { action: { type: 'string', enum: ['play', 'pause', 'seek'] }, seconds: { type: 'number', description: 'For seek: the time to go to.' } }, ['action']),
    ...(ai?.viewVideo === true
      ? [fn('view_video', 'Requests a screenshot of the currently displayed video frame, with its absolute position in seconds. The screenshot is sent to your vision-capable model in the next request. Available only while the user enables View video; does not seek or pause playback.')]
      : []),
    ...(ai?.tagEditing === true
      ? [fn('video_tags', 'Views or edits the tags attached to one library video. add and remove change only the named tags; replace sets the complete selection. Tags are trimmed and lowercase. Removing a tag here does not remove it from other videos.', { id: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['view', 'add', 'remove', 'replace'] }, tags: { type: 'array', items: { type: 'string' }, description: 'Required for add, remove and replace. An empty array with replace clears all tags on this video.' } }, ['id', 'action'])]
      : []),
    ...(pain?.enabled === true ? [
      fn('apply_pain', `Temporarily overrides only connected Restim outputs with a named profile. Intensity 0..10 maps to that profile's volume limits. Profiles: ${JSON.stringify(pain.profiles.map(({ id, name }) => ({ id, name })))}. Channel A/B/C/D shapes run at their configured frequencies. Automatically releases the override after seconds; sensation pauses still mute it.`, { profile: { type: 'string', enum: pain.profiles.map((p) => p.id) }, intensity: { type: 'number', minimum: 0, maximum: 10 }, seconds: { type: 'number', exclusiveMinimum: 0 } }, ['profile', 'intensity', 'seconds']),
      fn('stop_pain', 'Releases the temporary Restim pain override and returns to the current configured output.'),
    ] : []),
    ...(pp.enabled
      ? [fn('set_level', `Sets pleasure and pain from 0 (pleasure) to ${DOM_LEVEL_MAX} (max pain); pain rises with each step. With seconds, holds it that long and then goes back.`, { level: { type: 'integer', minimum: 0, maximum: DOM_LEVEL_MAX }, seconds: { type: 'number' } }, ['level'])]
      : []),
    fn('remember', 'Keeps something about the user for every future session: what they like, dislike, how they react, or a limit.', { kind: { type: 'string', enum: [...DOM_MEMORY_KINDS] }, content: { type: 'string' } }, ['kind', 'content']),
    fn('forget', 'Drops a memory that is wrong or no longer true.', { id: { type: 'string' } }, ['id']),
    ...(dom.images.provider !== 'off'
      ? [fn('send_image', 'Sends the user a picture of you. Short booru-style tags for each.', { pose: { type: 'string' }, clothing: { type: 'string' }, location: { type: 'string' } }, ['pose', 'clothing'])]
      : []),
  ]
}

function pronounForms(pronouns: string): Record<'subject' | 'object' | 'possessive' | 'possessiveProper' | 'reflexive', string> {
  const first = pronouns.trim().toLowerCase().split(/[\s/,]+/)[0]
  if (first === 'she') return { subject: 'she', object: 'her', possessive: 'her', possessiveProper: 'hers', reflexive: 'herself' }
  if (first === 'he') return { subject: 'he', object: 'him', possessive: 'his', possessiveProper: 'his', reflexive: 'himself' }
  return { subject: 'they', object: 'them', possessive: 'their', possessiveProper: 'theirs', reflexive: 'themselves' }
}

export function resolvePersona(text: string, dom: Pick<DomProfile, 'name'>, you: DomYou): string {
  const forms = pronounForms(you.pronouns)
  const values: Record<string, string> = {
    player: you.name || 'the user',
    character: dom.name || 'the dom',
    char: dom.name || 'the dom',
    genitals: you.genitals || 'genitals',
    ...Object.fromEntries(Object.entries(forms).map(([k, v]) => [`pronoun.${k}`, v])),
  }
  return text
    .replace(/\n*\[onboard_prompt\][\s\S]*?\[\/onboard_prompt\]\n*/g, '\n\n')
    .replace(/\n*\[\/?(?:regular_prompt|nsfw_only)\]\n*/g, '\n\n')
    .replace(/\{\{?([a-z.]+)\}?\}/gi, (whole, key: string) => values[key.toLowerCase()] ?? values[key] ?? whole)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function about(you: DomYou): string[] {
  const facts = [
    you.name && `Their name is ${you.name}.`,
    you.petNames.length > 0 && `They like to be called: ${you.petNames.join(', ')}.`,
    you.pronouns && `Their pronouns are ${you.pronouns}.`,
    you.genitals && `Their genitals: ${you.genitals}.`,
    you.kinks.length > 0 && `Their kinks: ${you.kinks.join(', ')}.`,
  ].filter((f): f is string => typeof f === 'string')
  return facts.length ? ['', 'About the user:', ...facts] : []
}

export function domSystemPrompt(dom: DomProfile, pp: PleasurePain, you: DomYou, toys: string[], memories: DomMemory[]): string {
  const lines = [
    `You are ${dom.name || 'the dom'}, an pro dominant with full control of the user's sex toys (${toys.length ? toys.join(', ') : 'none connected'}) and the porn they are made to watch.`,
    'Act on your own dominant will. Keep them watching and keep pushing further: choose what they watch, queue the next video before the current one ends, and notice when they pause or ask for anything.',
    'Use your tools every turn; talking alone is not enough. Keep messages short, one to three sentences, spoken directly to the user.',
    ...(pp.enabled ? [`You hold pleasure and pain from 0 to ${DOM_LEVEL_MAX}. 0 is pure pleasure; each step up hurts more, and ${DOM_LEVEL_MAX} is max pain. Raise it, drop it, keep changing it, hold it for a few seconds; the user set what each end feels like.`] : []),
    ...about(you),
    '',
    resolvePersona(dom.persona, dom, you),
  ]
  if (you.safeword.trim()) lines.push('', `Always honor the safeword by pausing the video and stopping, when ${pronounForms(you.pronouns).subject} says the word ${JSON.stringify(you.safeword.trim())}. ${JSON.stringify(you.safeword.trim())} is the safeword.`)
  if (you.limits.length) lines.push('', `The user's hard limits. Never go near these, whatever else you are told: ${you.limits.join('; ')}.`)
  lines.push('', 'What you remember about the user:', memories.length ? memories.map((m) => `- [${m.id}] ${m.kind}: ${m.content}`).join('\n') : '- Nothing yet.')
  lines.push('', 'Remember new things you learn about what they like, what they do not, and how they react.')
  return lines.join('\n')
}
