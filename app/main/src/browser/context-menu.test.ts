import type { MessageKey } from '@shared/i18n'
import { t } from '../i18n'
import type { BrowserWindow, ContextMenuParams, MenuItem, MenuItemConstructorOptions, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { showContextMenu } from './context-menu'

const native = vi.hoisted(() => ({ popup: vi.fn(), build: vi.fn(), copy: vi.fn() }))
vi.mock('electron', () => ({ Menu: { buildFromTemplate: native.build }, clipboard: { writeText: native.copy } }))

function setup(overrides: Partial<ContextMenuParams> = {}) {
  const contents = {
    isDestroyed: vi.fn(() => false), focus: vi.fn(), reload: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(),
    downloadURL: vi.fn(), copyImageAt: vi.fn(),
    navigationHistory: { canGoBack: vi.fn(() => true), canGoForward: vi.fn(() => false), goBack: vi.fn(), goForward: vi.fn() },
  }
  const params = {
    linkURL: '', srcURL: '', mediaType: 'none', isEditable: false, selectionText: '',
    x: 25, y: 40, hasImageContents: false, frame: null,
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false },
    ...overrides,
  } as ContextMenuParams
  const open = vi.fn()
  showContextMenu({} as BrowserWindow, contents as unknown as WebContents, params, open)
  const items: MenuItemConstructorOptions[] = native.build.mock.calls[0]![0]
  const item = (key: MessageKey) => items.find((entry) => entry.label === t(key))!
  const click = (key: MessageKey) => item(key).click!({} as MenuItem, undefined, {} as Electron.KeyboardEvent)
  return { contents, items, item, click, open }
}

beforeEach(() => {
  vi.clearAllMocks()
  native.build.mockReturnValue({ popup: native.popup })
})

describe('browser context menu', () => {
  it('opens the clicked link and copies its full URL', () => {
    const menu = setup({ linkURL: 'https://example.com/?q=a&b=2' })
    menu.click('main.contextMenu.openInNewTab')
    expect(menu.open).toHaveBeenCalledWith('https://example.com/?q=a&b=2')
    menu.click('main.contextMenu.copyLink')
    expect(native.copy).toHaveBeenCalledWith('https://example.com/?q=a&b=2')
    expect(menu.item('main.contextMenu.forward').enabled).toBe(false)
    menu.click('main.contextMenu.back')
    expect(menu.contents.navigationHistory.goBack).toHaveBeenCalledOnce()
  })

  it('does not execute script or local file links as new tabs', () => {
    for (const linkURL of ['javascript:alert(1)', 'file:///etc/passwd']) {
      native.build.mockClear()
      const menu = setup({ linkURL })
      expect(menu.item('main.contextMenu.openInNewTab').enabled).toBe(false)
      menu.click('main.contextMenu.openInNewTab')
      expect(menu.open).not.toHaveBeenCalled()
    }
  })

  it('keeps linked image actions separate and copies the clicked pixels', () => {
    const menu = setup({ linkURL: 'https://example.com/', mediaType: 'image', srcURL: 'https://example.com/a.png', hasImageContents: true })
    menu.click('main.contextMenu.openImageInNewTab')
    expect(menu.open).toHaveBeenCalledWith('https://example.com/a.png')
    menu.click('main.contextMenu.copyImage')
    expect(menu.contents.copyImageAt).toHaveBeenCalledWith(25, 40)
    menu.click('main.contextMenu.saveImageAs')
    expect(menu.contents.downloadURL).toHaveBeenCalledWith('https://example.com/a.png')
  })

  it('targets editing commands at the page and omits search in editable fields', () => {
    const menu = setup({ isEditable: true, selectionText: 'private text' })
    menu.click('main.contextMenu.paste')
    expect(menu.contents.paste).toHaveBeenCalledOnce()
    expect(menu.contents.focus).toHaveBeenCalledOnce()
    expect(menu.item('main.contextMenu.redo').enabled).toBe(false)
    expect(menu.item('main.contextMenu.searchWeb')).toBeUndefined()
  })

  it('searches selected text as a query even when it resembles a URL', () => {
    const menu = setup({ selectionText: 'https://example.com/?a=1&b=2' })
    menu.click('main.contextMenu.searchWeb')
    expect(menu.open).toHaveBeenCalledWith('https://www.bing.com/search?q=https%3A%2F%2Fexample.com%2F%3Fa%3D1%26b%3D2')
    menu.contents.isDestroyed.mockReturnValue(true)
    menu.click('main.contextMenu.reload')
    expect(menu.contents.reload).not.toHaveBeenCalled()
  })
})
