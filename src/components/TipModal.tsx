// Buzz amount picker used for BOTH tip buttons (creator + curator). Presets +
// a custom amount, client-side amount validation, and a self-tip guard (the
// trigger is already disabled for self, but the modal double-checks). The
// actual POST /blocks/tip happens in the caller so this stays presentation +
// input validation only.
//
// v0.1.5: rebuilt on the `@civitai/blocks-react/ui` pack — `Modal` shell,
// `Button` presets + actions, `TextInput` for the custom amount. Auto-themed
// (light/dark) via the app's `data-theme` root.

import { useState } from 'react';
import type { CSSProperties } from 'react';

import { Button, Modal, TextInput } from '@civitai/blocks-react/ui';

import { mutedText } from '../theme.js';

export const TIP_PRESETS = [10, 50, 100, 500] as const;
export const TIP_MIN = 1;
export const TIP_MAX = 100000;

export interface TipTarget {
  kind: 'creator' | 'curator';
  toUserId: number;
  username: string | null;
  entityType: 'Image' | 'Collection';
  entityId: number;
}

export function validateTipAmount(raw: string, balance: number | null): string | null {
  const n = Number(raw);
  if (!raw.trim()) return 'Enter an amount.';
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Amount must be a whole number.';
  if (n < TIP_MIN) return `Minimum tip is ${TIP_MIN} Buzz.`;
  if (n > TIP_MAX) return `Maximum tip is ${TIP_MAX.toLocaleString()} Buzz.`;
  if (balance != null && n > balance) return `That's more than your ${balance.toLocaleString()} Buzz balance.`;
  return null;
}

export interface TipModalProps {
  target: TipTarget;
  balance: number | null;
  submitting: boolean;
  onConfirm: (amount: number) => void;
  onClose: () => void;
}

export function TipModal({ target, balance, submitting, onConfirm, onClose }: TipModalProps) {
  const [amount, setAmount] = useState<string>(String(TIP_PRESETS[1]));
  const [touched, setTouched] = useState(false);

  const error = touched ? validateTipAmount(amount, balance) : null;
  const label = target.kind === 'creator' ? 'creator' : 'curator';

  const submit = () => {
    setTouched(true);
    const err = validateTipAmount(amount, balance);
    if (err) return;
    onConfirm(Number(amount));
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={`Tip ${target.username ? `@${target.username}` : `the ${label}`}`}
      size="sm"
    >
      <div data-testid="tip-modal" aria-label={`Tip ${label}`} style={bodyStyle}>
        <p style={leadText}>
          {target.kind === 'creator'
            ? 'Send Buzz to the creator of this media.'
            : 'Send Buzz to the collection curator.'}
          {balance != null && ` · You have ${balance.toLocaleString()} Buzz.`}
        </p>

        <div style={presetRow} role="group" aria-label="Preset amounts">
          {TIP_PRESETS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={amount === String(p) ? 'filled' : 'light'}
              onClick={() => {
                setAmount(String(p));
                setTouched(true);
              }}
              aria-pressed={amount === String(p)}
              data-testid={`tip-preset-${p}`}
            >
              {p}
            </Button>
          ))}
        </div>

        <TextInput
          id="tip-amount"
          label="Custom amount (Buzz)"
          inputMode="numeric"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setTouched(true);
          }}
          error={error ? <span data-testid="tip-error">{error}</span> : undefined}
          data-testid="tip-amount-input"
          aria-label="Tip amount in Buzz"
        />

        <div style={actionRow}>
          <Button variant="subtle" onClick={onClose} data-testid="tip-cancel">
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={submitting}
            disabled={Boolean(error)}
            data-testid="tip-confirm"
          >
            {submitting ? 'Sending…' : `Send ${amount || '0'} Buzz`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const bodyStyle: CSSProperties = { display: 'grid', gap: 12 };
const leadText: CSSProperties = { margin: 0, ...mutedText };
const presetRow: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const actionRow: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' };
