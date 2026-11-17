/**
 * Keyboard cursor of the queue is tracked by ticket id, never by row index:
 * live updates (SSE) can insert or reorder rows while the agent is navigating.
 */
export interface Focus {
  /** id of the row that currently has the cursor (null = no cursor) */
  id: string | null;
  /** index of that row in `ids` (-1 = no cursor) */
  index: number;
}

/**
 * Resolve where the cursor is after the list changed.
 * - the focused ticket still exists -> follow it to its new position
 * - it left the list -> the neighbour that took its former place (clamped)
 */
export function resolveFocus(
  ids: readonly string[],
  focusedId: string | null,
  lastIndex: number,
): Focus {
  if (focusedId === null || ids.length === 0) return { id: null, index: -1 };
  const found = ids.indexOf(focusedId);
  if (found >= 0) return { id: focusedId, index: found };
  const index = Math.min(Math.max(lastIndex, 0), ids.length - 1);
  return { id: ids[index] ?? null, index };
}

/** Move the cursor by `delta` rows from the currently resolved focus. */
export function moveFocus(ids: readonly string[], current: Focus, delta: 1 | -1): Focus {
  if (ids.length === 0) return { id: null, index: -1 };
  const index =
    current.index < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, current.index + delta));
  return { id: ids[index] ?? null, index };
}
