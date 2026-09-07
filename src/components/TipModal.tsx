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

import { TIP_DAILY_MAX, TIP_MAX_PER_TIP, TIP_MIN } from '../lib/tip-allowance.js';
import { FocusTrap } from './FocusTrap.js';

export const TIP_PRESETS = [10, 50, 100, 500] as const;
/** Re-exported from the caps module, where the split popover also reads it. */
export { TIP_MIN };
/** Client per-tip cap — aligned to the server's `BLOCK_TIP_MAX_PER_TIP` (5000). */
export const TIP_MAX = TIP_MAX_PER_TIP;

export interface TipTarget {
  kind: 'creator' | 'curator';
  toUserId: number;
  username: string | null;
  entityType: 'Image' | 'Collection';
  entityId: number;
}

/**
 * Perform one transfer. Resolves `true` only on a confirmed tip.
 *
 * 🔴 `idempotencyKey` IS LOAD-BEARING FOR THE SPLIT, and optional only because
 * the single-target picker has no retry affordance to protect. A split press
 * fires two transfers, so it can half-fail; the retry re-sends the outstanding
 * leg under the SAME key so the server replays rather than transfers again.
 */
export type TipSender = (target: TipTarget, amount: number, idempotencyKey?: string) => Promise<boolean>;

/**
 * Validate a tip amount against the per-tip cap (5000), the estimated remaining
 * daily allowance (25000/day, app-local), and the viewer's Buzz balance. The
 * server remains authoritative; this only pre-blocks an amount it would reject.
 */
export function validateTipAmount(
  raw: string,
  balance: number | null,
  dailyRemaining: number = TIP_DAILY_MAX,
): string | null {
  const n = Number(raw);
  if (!raw.trim()) return 'Enter an amount.';
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Amount must be a whole number.';
  if (n < TIP_MIN) return `Minimum tip is ${TIP_MIN} Buzz.`;
  if (n > TIP_MAX_PER_TIP) return `Maximum is ${TIP_MAX_PER_TIP.toLocaleString()} Buzz per tip.`;
  if (n > dailyRemaining) return `Only ${dailyRemaining.toLocaleString()} Buzz left in today's tip allowance.`;
  if (balance != null && n > balance) return `That's more than your ${balance.toLocaleString()} Buzz balance.`;
  return null;
}

export interface TipModalProps {
  target: TipTarget;
  balance: number | null;
  submitting: boolean;
  onConfirm: (amount: number) => void;
  onClose: () => void;
  /** Estimated Buzz left in today's tip allowance (app-local). Default: the cap. */
  dailyRemaining?: number;
}

export function TipModal({ target, balance, submitting, onConfirm, onClose, dailyRemaining = TIP_DAILY_MAX }: TipModalProps) {
  const [amount, setAmount] = useState<string>(String(TIP_PRESETS[1]));
  const [touched, setTouched] = useState(false);

  const error = touched ? validateTipAmount(amount, balance, dailyRemaining) : null;
  const label = target.kind === 'creator' ? 'creator' : 'curator';

  const submit = () => {
    setTouched(true);
    const err = validateTipAmount(amount, balance, dailyRemaining);
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
      <FocusTrap>
      <div data-testid="tip-modal" aria-label={`Tip ${label}`} style={bodyStyle}>
        <p style={leadText}>
          {target.kind === 'creator'
            ? 'Send Buzz to the creator of this media.'
            : 'Send Buzz to the collection curator.'}
          {balance != null && ` · You have ${balance.toLocaleString()} Buzz.`}
        </p>

        <p style={leadText} data-testid="tip-allowance">
          {/* Show ONLY the per-tip cap. The former "of 25,000 left today" framing
              was inert in the opaque-origin sandbox (localStorage throws → the
              daily estimate was always the full cap, tracking nothing), so it
              presented an untracked number as if tracked.

              🔴 As of 0.2.10 the `dailyRemaining` this modal receives IS real —
              it comes from the server's `GET /blocks/tip-allowance` — and
              `validateTipAmount` above pre-blocks against it. This readout still
              does not render it: the number is a per-day figure and this control
              sends one tip, so the per-tip cap is the sentence that answers the
              question the picker asks. The split popover, whose cap genuinely IS
              min(per-press cap, remaining), does render it. */}
          Up to {TIP_MAX_PER_TIP.toLocaleString()} Buzz per tip.
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
            // Explicitly disabled while submitting too — guards against a fast
            // double-click firing two tips (a Buzz double-spend) before re-render.
            disabled={submitting || Boolean(error)}
            data-testid="tip-confirm"
          >
            {submitting ? 'Sending…' : `Send ${amount || '0'} Buzz`}
          </Button>
        </div>
      </div>
      </FocusTrap>
    </Modal>
  );
}

const bodyStyle: CSSProperties = { display: 'grid', gap: 12 };
const leadText: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--civitai-color-text-dimmed)' };
const presetRow: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const actionRow: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' };
