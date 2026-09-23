import { clipboard, Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { t } from '../i18n'
import { webUrl } from './storage'

export function showContextMenu(window: BrowserWindow, contents: WebContents, params: ContextMenuParams, openTab: (url: string) => void) {
  const items: MenuItemConstructorOptions[] = []
  const add = (label: string, action: () => void, enabled = true) => {
    items.push({ label, enabled, click: () => {
      if (!contents.isDestroyed() && enabled) action()
    } })
  }
  const separator = () => { if (items.length) items.push({ type: 'separator' }) }

  if (params.linkURL) {
    add(t('main.contextMenu.openInNewTab'), () => openTab(params.linkURL), webUrl(params.linkURL))
    add(t('main.contextMenu.copyLink'), () => clipboard.writeText(params.linkURL))
  }

  if (params.mediaType === 'image') {
    separator()
    const imageUrl = webUrl(params.srcURL) || /^(data:image\/|blob:https?:\/\/)/i.test(params.srcURL)
    add(params.linkURL ? t('main.contextMenu.openImageInNewTab') : t('main.contextMenu.openInNewTab'), () => openTab(params.srcURL), imageUrl)
    add(t('main.contextMenu.saveImageAs'), () => contents.downloadURL(params.srcURL), imageUrl && params.hasImageContents)
    add(t('main.contextMenu.copyImage'), () => contents.copyImageAt(params.x, params.y), params.hasImageContents)
    add(t('main.contextMenu.copyImageAddress'), () => clipboard.writeText(params.srcURL), !!params.srcURL)
  }

  const flags = params.editFlags
  if (params.isEditable) {
    separator()
    add(t('main.contextMenu.undo'), () => contents.undo(), flags.canUndo)
    add(t('main.contextMenu.redo'), () => contents.redo(), flags.canRedo)
    separator()
    add(t('main.contextMenu.cut'), () => contents.cut(), flags.canCut)
    add(t('main.contextMenu.copy'), () => contents.copy(), flags.canCopy)
    add(t('main.contextMenu.paste'), () => contents.paste(), flags.canPaste)
    separator()
    add(t('main.contextMenu.selectAll'), () => contents.selectAll(), flags.canSelectAll)
  } else if (params.selectionText.trim()) {
    separator()
    add(t('main.contextMenu.copy'), () => contents.copy(), flags.canCopy)
    add(t('main.contextMenu.searchWeb'), () => openTab(`https://www.bing.com/search?q=${encodeURIComponent(params.selectionText.trim())}`))
  }

  separator()
  const history = contents.navigationHistory
  add(t('main.contextMenu.back'), () => { if (history.canGoBack()) history.goBack() }, history.canGoBack())
  add(t('main.contextMenu.forward'), () => { if (history.canGoForward()) history.goForward() }, history.canGoForward())
  add(t('main.contextMenu.reload'), () => contents.reload())
  contents.focus()
  Menu.buildFromTemplate(items).popup({ window, frame: params.frame ?? undefined })
}
