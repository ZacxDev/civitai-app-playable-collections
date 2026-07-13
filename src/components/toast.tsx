// Minimal toast system: a hook that owns a queue + a host component that renders
// it. Used for tip success/failure, rate-limit backoff notices, and follow
// errors. Auto-dismisses; `role="status"`/`role="alert"` for a screen reader.

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type { Palette } from '../theme.js';

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

export function ToastHost({
  toasts,
  onDismiss,
  c,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  c: Palette;
}) {
  return (
    <div style={hostStyle} aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-testid={`toast-${t.kind}`}
          style={toastStyle(c, t.kind)}
          onClick={() => onDismiss(t.id)}
        >
          {t.message}
        </div>
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
  zIndex: 1000,
  width: 'min(92vw, 420px)',
};

function toastStyle(c: Palette, kind: ToastKind): CSSProperties {
  const border =
    kind === 'error' ? c.danger : kind === 'success' ? c.success : c.border;
  return {
    background: c.card,
    color: c.fg,
    border: '1px solid ' + border,
    borderLeft: '4px solid ' + border,
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 13,
    lineHeight: 1.4,
    cursor: 'pointer',
    boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
  };
}
