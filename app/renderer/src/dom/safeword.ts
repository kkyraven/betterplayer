export function saysSafeword(text: string, safeword: string): boolean {
  const word = safeword.normalize('NFKC').trim()
  if (!word) return false
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escaped}(?![\\p{L}\\p{N}\\p{M}_])`, 'iu').test(text.normalize('NFKC'))
}
