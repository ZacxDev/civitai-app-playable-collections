// Minimal toast system: a hook that owns a queue + a host component that renders
// it. Used for tip success/failure, rate-limit backoff notices, and follow
// errors. Auto-dismisses; `role="status"`/`role="alert"` for a screen reader.

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { token } from '../theme.js';

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
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div style={hostStyle} aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-testid={`toast-${t.kind}`}
          style={toastStyle(t.kind)}
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

function toastStyle(kind: ToastKind): CSSProperties {
  const accent =
    kind === 'error' ? token.error : kind === 'success' ? token.success : token.border;
  return {
    background: token.surface,
    color: token.text,
    border: `1px solid ${token.border}`,
    borderLeft: `4px solid ${accent}`,
    borderRadius: 'var(--civitai-radius)',
    padding: '10px 14px',
    fontSize: 13,
    lineHeight: 1.4,
    cursor: 'pointer',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.25)',
  };
}
