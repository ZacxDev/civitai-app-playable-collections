// Minimal toast system: a hook that owns a queue + a host component that renders
// it. Used for tip success/failure, rate-limit backoff notices, and follow
// errors. Auto-dismisses (the queue owns the TTL; the renderer is presentational).
//
// v0.1.5: the toast surface was the `@civitai/blocks-react/ui` `Alert`.
// 🔴 PHASE 2 (surface 3): the surface is the upstream `<civitai-toast>`
// element now. The mapping is 1:1 with what the Alert provided — `color`
// takes the toast kind, the ARIA role moves to the element itself
// (`urgent` → role=alert for errors, role=status otherwise, set on
// connect), the close button is the element's (`closable`), and the
// message stays light-DOM children in the element's default slot, so
// text queries and copy are unchanged. Placement stays the app's:
// bottom-centre, app width — the element's own ToastRegion (bottom-right)
// was not adopted; where toasts appear is this app's choice, what a toast
// IS is now upstream's.

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

// Per-element deep import (see ContinuousView.tsx for why not the barrel).
import { CivitaiToast } from '@civitai/components-react/elements/civitai-toast';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface UseToasts {
  toasts: Toast[];
  push(kind: ToastKind, message: string, ttlMs?: number): void;
  dismiss(id: number): void;
}

export function useToasts(): UseToasts {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, ttlMs = 4000) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((list) => [...list, { id, kind, message }]);
      if (ttlMs > 0) {
        setTimeout(() => dismiss(id), ttlMs);
      }
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export function ToastHost({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div style={hostStyle}>
      {toasts.map((t) => (
        <CivitaiToast
          key={t.id}
          color={t.kind}
          urgent={t.kind === 'error'}
          closable
          closeLabel="Dismiss"
          onClose={() => onDismiss(t.id)}
          data-testid={`toast-${t.kind}`}
          style={{ cursor: 'pointer' }}
          onClick={() => onDismiss(t.id)}
        >
          {t.message}
        </CivitaiToast>
      ))}
    </div>
  );
}

const hostStyle: CSSProperties = {
  position: 'fixed',
  bottom: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'grid',
  gap: 8,
  zIndex: 2000,
  width: 'min(92vw, 420px)',
};
