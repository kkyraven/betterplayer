import type { FolderNode } from '@shared/library'

export function sidebarKey(source: string, id: number, folder?: string): string {
  return JSON.stringify(folder === undefined ? [source, id] : [source, id, folder])
}

export function orderedItems<T>(items: readonly T[], order: readonly string[], key: (item: T) => string): T[] {
  const positions = new Map(order.map((id, index) => [id, index]))
  return [...items].sort((a, b) => (positions.get(key(a)) ?? order.length) - (positions.get(key(b)) ?? order.length))
}

export function moveItem<T>(items: readonly T[], item: T, position: number): T[] {
  if (!items.includes(item)) return [...items]
  const next = items.filter((value) => value !== item)
  next.splice(Math.max(0, Math.min(position, next.length)), 0, item)
  return next
}

export function dropItem<T>(items: readonly T[], item: T, target: T, after: boolean): T[] {
  const from = items.indexOf(item)
  const to = items.indexOf(target)
  if (from < 0 || to < 0 || item === target) return [...items]
  return moveItem(items, item, to + (after ? 1 : 0) - (from < to ? 1 : 0))
}

export function flattenFolders(nodes: readonly FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenFolders(node.children)])
}
