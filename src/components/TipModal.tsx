// Buzz amount picker used for BOTH tip buttons (creator + curator). Presets +
// a custom amount, client-side amount validation, and a self-tip guard (the
// trigger is already disabled for self, but the modal double-checks). The
// actual POST /blocks/tip happens in the caller so this stays presentation +
// input validation only.

import { useState } from 'react';
import type { CSSProperties } from 'react';

import type { Palette } from '../theme.js';
import { primaryBtn, ghostBtn, inputStyle, chipStyle } from './styles.js';

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
  c: Palette;
}

export function TipModal({ target, balance, submitting, onConfirm, onClose, c }: TipModalProps) {
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
    <div
      style={backdrop(c)}
      data-testid="tip-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Tip ${label}`}
      onClick={onClose}
    >
      <div style={dialog(c)} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 17 }}>
          Tip {target.username ? `@${target.username}` : `the ${label}`}
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: c.muted }}>
          {target.kind === 'creator'
            ? 'Send Buzz to the creator of this media.'
            : 'Send Buzz to the collection curator.'}
          {balance != null && ` · You have ${balance.toLocaleString()} Buzz.`}
        </p>

        <div style={presetRow} role="group" aria-label="Preset amounts">
          {TIP_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setAmount(String(p));
                setTouched(true);
              }}
              style={chipStyle(c, amount === String(p))}
              aria-pressed={amount === String(p)}
              data-testid={`tip-preset-${p}`}
            >
              {p}
            </button>
          ))}
        </div>

        <label style={{ fontSize: 13, fontWeight: 600 }} htmlFor="tip-amount">
          Custom amount (Buzz)
        </label>
        <input
          id="tip-amount"
          inputMode="numeric"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setTouched(true);
          }}
          style={inputStyle(c)}
          data-testid="tip-amount-input"
          aria-label="Tip amount in Buzz"
        />
        {error && (
          <p role="alert" data-testid="tip-error" style={{ margin: 0, fontSize: 13, color: c.danger }}>
            {error}
          </p>
        )}

        <div style={actionRow}>
          <button type="button" onClick={onClose} style={ghostBtn(c)} data-testid="tip-cancel">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || Boolean(error)}
            style={primaryBtn(c, submitting || Boolean(error))}
            data-testid="tip-confirm"
          >
            {submitting ? 'Sending…' : `Send ${amount || '0'} Buzz`}
          </button>
        </div>
      </div>
    </div>
  );
}

function backdrop(c: Palette): CSSProperties {
  return {
    position: 'fixed',
    inset: 0,
    background: c.overlay,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 1100,
    padding: 12,
  };
}

function dialog(c: Palette): CSSProperties {
  return {
    background: c.bg,
    color: c.fg,
    border: '1px solid ' + c.border,
    borderRadius: 14,
    padding: 18,
    width: 'min(96vw, 420px)',
    display: 'grid',
    gap: 12,
    marginBottom: 'env(safe-area-inset-bottom, 0px)',
  };
}

const presetRow: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const actionRow: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' };
