const CONTROL_SELECTOR = 'input, textarea, select, button, a[href], [role="button"], [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"]'

export function spaceIsClaimed(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat) return true
  if (window.getSelection()?.isCollapsed === false) return true
  return [event.target, document.activeElement].some((target) =>
    target instanceof HTMLElement && (target.isContentEditable || target.closest(CONTROL_SELECTOR) !== null),
  )
}
