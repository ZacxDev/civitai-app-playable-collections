// Focus trap (ship-blocker #4).
//
// The pack `Modal` focuses its panel on open and RESTORES focus to the prior
// element on close, but by its own documentation does NOT trap focus inside the
// panel (Tab can reach content behind the overlay). We wrap dialog/lightbox
// content in this trap so Tab / Shift+Tab cycle within the surface. It can also
// autofocus the first control and restore focus itself (for the custom lightbox,
// which is not a pack Modal).

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

export interface FocusTrapProps {
  children: ReactNode;
  /** Focus the first focusable element on mount. Default false. */
  autoFocus?: boolean;
  /** Save the active element on mount and restore it on unmount. Default false
   * (leave to the pack Modal, which already restores). */
  restoreFocus?: boolean;
}

export function FocusTrap({ children, autoFocus = false, restoreFocus = false }: FocusTrapProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = restoreFocus && typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    if (autoFocus) focusable(ref.current)[0]?.focus();
    return () => {
      if (restoreFocus) prev?.focus?.();
    };
  }, [autoFocus, restoreFocus]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = focusable(ref.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const inside = ref.current?.contains(active);
    if (e.shiftKey) {
      if (active === first || !inside) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !inside) {
      e.preventDefault();
      first.focus();
    }
  };

  // `display: contents` so the wrapper adds no layout box.
  return (
    <div ref={ref} onKeyDown={onKeyDown} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}
