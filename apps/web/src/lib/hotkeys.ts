/** Hotkeys must never fire while the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    target.getAttribute('role') === 'textbox'
  );
}

export type HotkeyAction = 'next' | 'prev' | 'open' | 'search' | 'help';

/** Maps a keyboard event to a queue action, or null when it must be ignored. */
export function hotkeyAction(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): HotkeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  switch (e.key) {
    case 'j':
      return 'next';
    case 'k':
      return 'prev';
    case 'Enter':
      return 'open';
    case '/':
      return 'search';
    case '?':
      return 'help';
    default:
      return null;
  }
}
