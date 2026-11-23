const nonTextInputs = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image', 'hidden']);

export function dawHistoryShortcut(event: KeyboardEvent): 'undo' | 'redo' | undefined {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  const action = key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' && !event.shiftKey ? 'redo' : undefined;
  if (!action) return;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable || target.closest('textarea,[role="textbox"]')) return;
    const input = target.closest('input');
    if (input && !nonTextInputs.has(input.type)) return;
  }
  return action;
}
