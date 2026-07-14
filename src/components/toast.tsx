// Minimal toast system: a hook that owns a queue + a host component that renders
// it. Used for tip success/failure, rate-limit backoff notices, and follow
// errors. Auto-dismisses; the pack `Alert` supplies the ARIA role
// (error → assertive `alert`, success/info → polite `status`).
//
// v0.1.5: the toast surface is the `@civitai/blocks-react/ui` `Alert` so it
// matches Civitai's callout styling (auto-themed via the app's `data-theme`).

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Alert } from '@civitai/blocks-react/ui';

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
    <div style={hostStyle} aria-live="polite">
      {toasts.map((t) => (
        <Alert
          key={t.id}
          color={t.kind}
          withCloseButton
          onClose={() => onDismiss(t.id)}
          closeButtonLabel="Dismiss"
          data-testid={`toast-${t.kind}`}
          style={toastStyle}
          onClick={() => onDismiss(t.id)}
        >
          {t.message}
        </Alert>
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

const toastStyle: CSSProperties = {
  cursor: 'pointer',
  boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
  // Sit the tinted callout on an opaque surface so it reads as a floating toast
  // over arbitrary page content (the pack Alert tint alone is near-transparent).
  backgroundColor: 'var(--ci-color-surface)',
  backgroundImage:
    'linear-gradient(color-mix(in srgb, currentColor 8%, transparent), color-mix(in srgb, currentColor 8%, transparent))',
};
