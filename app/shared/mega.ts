export const MEGA_PREPARE_TIMEOUT_MS = 30_000

export function megaDownloadName(name: string): string {
  let result = name.replace(/["*/:<>?\\|]+/g, '-')
  if (result.length > 240) result = `${result.slice(0, 240)}.${result.split('.').at(-1)}`
  result = result.replace(/[\t\n\v\f\r\u200e\u200f\u202e]+/g, ' ')
  const extension = result.lastIndexOf('.')
  const stem = extension > 0 ? result.slice(0, extension) : result
  return /^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `!${result}` : result
}
