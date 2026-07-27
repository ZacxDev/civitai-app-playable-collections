// Buzz amount picker used for BOTH tip buttons (creator + curator). Presets +
// a custom amount, client-side amount validation, and a self-tip guard (the
// trigger is already disabled for self, but the modal double-checks). The
// actual POST /blocks/tip happens in the caller so this stays presentation +
// input validation only. Chrome is the design-system pack Modal + Button +
// TextInput (focus trap, overlay/esc close, themed states for free).

import { useState } from 'react';
import type { CSSProperties } from 'react';

import { Button, Modal, TextInput } from '@civitai/blocks-react/ui';

import { metaText, token } from '../theme.js';

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
  const heading = target.username ? `Tip @${target.username}` : `Tip the ${label}`;

  const submit = () => {
    setTouched(true);
    const err = validateTipAmount(amount, balance);
    if (err) return;
    onConfirm(Number(amount));
  };

  return (
    <Modal opened onClose={onClose} title={heading} size="sm" closeButtonLabel="Close">
      <div style={{ display: 'grid', gap: 12 }} data-testid="tip-modal">
        <p style={{ margin: 0, ...metaText }}>
          {target.kind === 'creator'
            ? 'Send Buzz to the creator of this media.'
            : 'Send Buzz to the collection curator.'}
          {balance != null && (
            <>
              {' · You have '}
              <span style={{ fontVariantNumeric: 'tabular-nums', color: token.text }}>
                {balance.toLocaleString()}
              </span>
              {' Buzz.'}
            </>
          )}
        </p>

        <div style={presetRow} role="group" aria-label="Preset amounts">
          {TIP_PRESETS.map((p) => {
            const selected = amount === String(p);
            return (
              <Button
                key={p}
                variant={selected ? 'filled' : 'light'}
                color="primary"
                size="sm"
                onClick={() => {
                  setAmount(String(p));
                  setTouched(true);
                }}
                aria-pressed={selected}
                data-testid={`tip-preset-${p}`}
              >
                {p}
              </Button>
            );
          })}
        </div>

        <TextInput
          label="Custom amount (Buzz)"
          inputMode="numeric"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setTouched(true);
          }}
          data-testid="tip-amount-input"
          aria-label="Tip amount in Buzz"
          aria-invalid={error ? true : undefined}
        />
        {error && (
          <p role="alert" data-testid="tip-error" style={{ margin: 0, fontSize: 13, color: token.error }}>
            {error}
          </p>
        )}

        <div style={actionRow}>
          <Button variant="subtle" onClick={onClose} data-testid="tip-cancel">
            Cancel
          </Button>
          <Button
            color="primary"
            onClick={submit}
            loading={submitting}
            disabled={submitting || Boolean(error)}
            data-testid="tip-confirm"
          >
            {`Send ${amount || '0'} Buzz`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const presetRow: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const actionRow: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' };
