/** Drafts live in localStorage under `draft:<userId>:<ticketId|new>`. */
export const draftKey = (userId: string, scope: string): string => `draft:${userId}:${scope}`;

/** Reads a draft; guard validates the stored JSON so corrupt data is ignored. */
export function loadDraft<T>(key: string, guard: (value: unknown) => value is T): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable: drafts are best effort */
  }
}

export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
