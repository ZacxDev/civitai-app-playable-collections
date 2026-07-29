// Pure keyboard-navigation helpers for the WAI-ARIA roving-focus patterns
// (tablist + radiogroup segmented control). Keeping the arithmetic pure means
// the arrow-key / Home / End behaviour is unit-tested without a renderer; the
// components only wire refs + focus.

export type RovingAction = 'next' | 'prev' | 'first' | 'last' | null;

/**
 * Map a key event to a roving action for a horizontal or vertical group.
 * Horizontal: ArrowLeft/ArrowRight; vertical: ArrowUp/ArrowDown. Home/End jump
 * to the ends in both. Anything else → null (let the event through).
 */
export function rovingAction(key: string, orientation: 'horizontal' | 'vertical' = 'horizontal'): RovingAction {
  const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const prevKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  if (key === nextKey) return 'next';
  if (key === prevKey) return 'prev';
  if (key === 'Home') return 'first';
  if (key === 'End') return 'last';
  return null;
}

/**
 * The index a roving action moves to, wrapping at both ends. `current` is the
 * currently-focused/selected index; `length` the item count. Returns `current`
 * unchanged for an empty group.
 */
export function nextIndex(action: RovingAction, current: number, length: number): number {
  if (length <= 0) return current;
  switch (action) {
    case 'next':
      return (current + 1) % length;
    case 'prev':
      return (current - 1 + length) % length;
    case 'first':
      return 0;
    case 'last':
      return length - 1;
    default:
      return current;
  }
}
