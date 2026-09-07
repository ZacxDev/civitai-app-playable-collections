// The %-split tip popover: one amount, one slider, one confirm — Buzz divided
// between the creator of the media on screen and the collection's curator
// (operator feedback round 3).
//
// Built on the same `@civitai/blocks-react/ui` shell as `TipModal` (Modal +
// preset Buttons + TextInput + FocusTrap) with a percentage `Slider` added, and
// on the app's own `ApiClient.tip` underneath.
//
// 🔴 NOT `TipButton` FROM THE UI PACK, AND THAT IS A DECISION, NOT AN OVERSIGHT.
// The upstream control takes a FIXED `amount` prop and owns its own confirm — it
// has no amount picker. Adopting it would delete the store description's promise
// that the amount and the split are "picked and confirmed by you first", which is
// the whole point of this surface.
//
// 🔴 THE RETRY IS THE REASON A PLAN EXISTS AT ALL. Two transfers leave one
// press, so "it failed" has a THIRD outcome besides ok/failed: one leg landed
// and the other did not. Re-running the whole press would re-send the leg that
// already succeeded. So a confirm builds a PLAN — one leg per recipient, each
// with its own idempotency key minted ONCE — and the retry re-runs only the legs
// not yet marked `sent`, WITH THEIR ORIGINAL KEYS. The status guard covers the
// leg we know landed; the key covers the leg whose response was lost (from
// inside the iframe those two are indistinguishable, which is exactly why both
// are needed).
//
// 🔴 AND THE PLAN IS NOT THIS COMPONENT'S STATE — IT IS A PROP, BECAUSE THIS
// COMPONENT IS UNMOUNTED BY THE BUTTON NEXT TO THE PROMISE. `plan` lived in a
// local `useState` until an audit walked the reachable sequence: leg 1 lands,
// leg 2 is refused, the viewer presses **Close** (this component relabels Cancel
// to exactly that in the failed state, right beside the words "the parts already
// sent cannot be sent twice"), reopens, confirms — and every key is freshly
// minted, so the server has nothing to replay and the landed leg is paid twice.
// The owner (App, via Player) keeps the plan keyed to the LOGICAL tip
// (`splitTipKey`), so a reopen RESUMES it rather than starting a new one. Every
// mutation of the plan goes out through `onPlanChange`.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Button, Modal, Slider, TextInput } from '@civitai/blocks-react/ui';

import {
  DEFAULT_CREATOR_PERCENT,
  TIP_TOTAL_MAX,
  newIdempotencyKey,
  splitTipTotal,
  validateTipSplit,
  type TipLegKind,
} from '../lib/tip-split.js';
import { effectiveTipCap } from '../lib/tip-allowance.js';
import { FocusTrap } from './FocusTrap.js';
import type { TipTarget } from './TipModal.js';

/** Preset totals, mirroring `TipModal`'s so the two pickers feel like one control. */
export const SPLIT_PRESETS = [10, 50, 100, 500] as const;
/** Preset splits, as the creator's share. */
export const SPLIT_PERCENT_PRESETS = [100, 75, 50, 25, 0] as const;

/** One side of the split, or `null` when that side cannot receive (self / absent). */
export type SplitRecipient = TipTarget | null;

/** A leg of the plan, plus everything needed to send and re-send it. */
export interface PlannedLeg {
  kind: TipLegKind;
  amount: number;
  target: TipTarget;
  /** Minted ONCE when the plan is built; reused on every retry. */
  idempotencyKey: string;
  status: 'pending' | 'sent' | 'failed';
}

/**
 * The identity of ONE LOGICAL TIP: this pair of recipients, for these exact
 * entities. It is what the plan is stored under, so closing and reopening the
 * popover on the same media RESUMES the plan (original keys, `sent` markers
 * intact) instead of minting a second one.
 *
 * 🔴 IT MUST NAME THE ENTITIES, NOT JUST THE PEOPLE. Two different images by the
 * same creator in the same collection are two different tips and must never
 * share a plan — sharing one would make the second press replay the first
 * press's transfer and silently send nothing.
 */
export function splitTipKey(creator: SplitRecipient, curator: SplitRecipient): string {
  const part = (r: SplitRecipient) => (r ? `${r.entityType}:${r.entityId}:${r.toUserId}` : '-');
  return `${part(creator)}|${part(curator)}`;
}

export interface TipSplitModalProps {
  /** The creator of the media on screen, or `null` when it is the viewer / absent. */
  creator: SplitRecipient;
  /** The collection's curator, or `null` when it is the viewer. */
  curator: SplitRecipient;
  balance: number | null;
  /** A tip request is in flight (App's shared flag). */
  submitting: boolean;
  /** The viewer's REAL remaining daily allowance; omit when it is unknown. */
  dailyRemaining?: number;
  /**
   * Send ONE leg. Resolves `true` only on a confirmed transfer. MUST pass
   * `idempotencyKey` through to the server unchanged — the retry depends on it.
   */
  onSendLeg: (target: TipTarget, amount: number, idempotencyKey: string) => Promise<boolean>;
  /** Every leg landed. The caller closes the popover and marks the tip done. */
  onDone: (legs: ReadonlyArray<{ kind: TipLegKind; amount: number }>) => void;
  onClose: () => void;
  /**
   * The plan for THIS logical tip, owned by the caller so it survives this
   * component being unmounted (see the header). `null` = no press yet.
   */
  plan: PlannedLeg[] | null;
  /** Hand every plan mutation back to the owner. `null` retires the plan. */
  onPlanChange: (plan: PlannedLeg[] | null) => void;
  /**
   * Report the in-flight window up, so the surface AROUND this popover can stop
   * dismissing it mid-transfer (the app's own Escape handler, chiefly).
   */
  onSendingChange?: (sending: boolean) => void;
  /** Key minter (test seam) — default `newIdempotencyKey`. */
  newKey?: () => string;
}

export function TipSplitModal({
  creator,
  curator,
  balance,
  submitting,
  dailyRemaining,
  onSendLeg,
  onDone,
  onClose,
  plan,
  onPlanChange,
  onSendingChange,
  newKey = newIdempotencyKey,
}: TipSplitModalProps) {
  // A RESUMED plan (reopened after a partial failure) decides the amount and the
  // split — the inputs are locked in that state, so showing the defaults instead
  // would put a number on screen that is not the one being sent.
  const resumedTotal = plan ? plan.reduce((sum, l) => sum + l.amount, 0) : 0;
  const [amount, setAmount] = useState<string>(() =>
    plan ? String(resumedTotal) : String(SPLIT_PRESETS[1]),
  );
  const [creatorPercent, setCreatorPercent] = useState<number>(() => {
    if (!plan || resumedTotal <= 0) return DEFAULT_CREATOR_PERCENT;
    return Math.round(((plan.find((l) => l.kind === 'creator')?.amount ?? 0) / resumedTotal) * 100);
  });
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  // Guards a second confirm/retry entering the send loop in the same tick, before
  // `setSending(true)` re-renders the disabled button (the split's equivalent of
  // App's `tipInFlightRef`, and it matters more here — a double entry would run
  // the loop twice over the same plan).
  const sendingRef = useRef(false);

  const eligibility = useMemo(
    () => ({ creatorEligible: creator != null, curatorEligible: curator != null }),
    [creator, curator],
  );
  const bothEligible = eligibility.creatorEligible && eligibility.curatorEligible;

  const error = touched ? validateTipSplit(amount, balance, creatorPercent, eligibility, dailyRemaining) : null;
  // The preview the viewer reads BEFORE confirming — the actual per-recipient
  // amounts, clamps applied, not the raw percentage. Once a plan exists the
  // preview is READ FROM THE PLAN: those are the amounts the keys were minted
  // for, and they are what a retry will send.
  //
  // ⚠️ The `plan ??` arm is BELT-AND-BRACES, not observable behaviour, and no
  // test can kill it: `amount` and `creatorPercent` above are derived from the
  // same plan, and `splitTipTotal` round-trips those back to the identical legs
  // for every reachable plan (brute-forced over all 504,901 (total, percent)
  // pairs in [1,5000]×[0,100] — zero divergences). It is kept because the plan
  // is the thing the SERVER has seen, and that should not depend on a rounding
  // round-trip staying lossless. Do not read it as covered by a guard.
  const preview = plan ?? splitTipTotal(Number(amount), creatorPercent, eligibility);
  const previewFor = (kind: TipLegKind) => preview.find((l) => l.kind === kind)?.amount ?? 0;

  const ceiling = effectiveTipCap(dailyRemaining ?? TIP_TOTAL_MAX);

  const setSendingBoth = useCallback(
    (v: boolean) => {
      setSending(v);
      onSendingChange?.(v);
    },
    [onSendingChange],
  );

  const runPlan = useCallback(
    async (legs: PlannedLeg[]) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setSendingBoth(true);
      // Work on a copy so a failure part-way still reports the legs that landed.
      const next = legs.map((l) => ({ ...l }));
      try {
        for (const leg of next) {
          // 🔴 SKIP WHAT ALREADY LANDED. Without this a retry re-sends a
          // confirmed transfer; the idempotency key would collapse it server-side,
          // but relying on that would make the key the ONLY thing between a retry
          // and a double-spend.
          if (leg.status === 'sent') continue;
          const ok = await onSendLeg(leg.target, leg.amount, leg.idempotencyKey);
          leg.status = ok ? 'sent' : 'failed';
          onPlanChange(next.map((l) => ({ ...l })));
        }
      } finally {
        sendingRef.current = false;
        setSendingBoth(false);
      }
      onPlanChange(next);
      if (next.every((l) => l.status === 'sent')) {
        onDone(next.map((l) => ({ kind: l.kind, amount: l.amount })));
      }
    },
    [onSendLeg, onDone, onPlanChange, setSendingBoth],
  );

  const confirm = () => {
    // 🔴 SYNCHRONOUS RE-ENTRANCE GATE, BEFORE ANY KEY IS MINTED. `setSending`
    // only disables the button on the NEXT render, so two clicks in one tick both
    // reach here — and the second would mint a SECOND set of keys over the plan
    // already being sent, replacing what the owner is holding for the retry.
    // `runPlan`'s own guard is too late for that: the keys are minted first.
    if (sendingRef.current || plan != null) return;
    setTouched(true);
    if (validateTipSplit(amount, balance, creatorPercent, eligibility, dailyRemaining)) return;
    const legs = splitTipTotal(Number(amount), creatorPercent, eligibility);
    const planned: PlannedLeg[] = legs.map((leg) => {
      const target = leg.kind === 'creator' ? creator : curator;
      // `splitTipTotal` only emits a leg whose side is eligible, and eligibility
      // IS "the recipient is non-null" — so this cannot be null in practice. The
      // non-null assertion is the type system catching up, not a claim.
      return { kind: leg.kind, amount: leg.amount, target: target as TipTarget, idempotencyKey: newKey(), status: 'pending' };
    });
    onPlanChange(planned);
    void runPlan(planned);
  };

  const retry = () => {
    if (plan) void runPlan(plan);
  };

  /**
   * Retire a plan on which NOTHING landed, so the viewer can pick a different
   * amount instead of being locked to the one that failed.
   *
   * 🔴 THIS IS NEVER AUTOMATIC, AND THAT IS THE WHOLE DESIGN. A leg marked
   * `failed` may be one whose transfer actually reached the server and only
   * whose RESPONSE was lost — from inside the iframe those two are
   * indistinguishable — so its key is still worth replaying. Auto-discarding a
   * failed plan is precisely how a recoverable state turns into a double-spend.
   * The viewer presses this deliberately, next to copy that says what it costs.
   */
  const discard = () => {
    if (sendingRef.current) return;
    onPlanChange(null);
    // 🔴 MOVE FOCUS, OR THE FOCUS TRAP IS DEFEATED. This button unmounts its own
    // subtree, so focus falls to `document.body` — and `FocusTrap`'s Tab handler
    // is a React `onKeyDown` on the wrapper div, which a keypress originating at
    // `body` never reaches. Tab would then walk the page BEHIND the overlay.
    // (The pre-existing confirm→retry swap does not have this problem: React
    // reuses that node, so focus stays inside.) The amount field is also exactly
    // where the note sends the viewer — "start over at a different amount" — so
    // this is the correct destination, not just a trap repair.
    requestAnimationFrame(() => {
      document.getElementById('tip-split-amount')?.focus();
    });
  };

  const failed = plan?.some((l) => l.status === 'failed') ?? false;
  const sentLegs = plan?.filter((l) => l.status === 'sent') ?? [];
  const busy = sending || submitting;
  /**
   * 🔴 OFFERED ONLY WHEN NOTHING LANDED. Once a leg is `sent`, discarding would
   * mint fresh keys and re-send it — paying that recipient twice, which is the
   * exact failure the plan exists to prevent. In that state Retry is the only
   * safe move forward, so this affordance is ABSENT there rather than disabled:
   * a greyed-out button still reads as "an option I could have".
   */
  const nothingLanded = failed && sentLegs.length === 0;

  const title = bothEligible
    ? 'Split a tip'
    : eligibility.creatorEligible
      ? `Tip ${creator?.username ? `@${creator.username}` : 'the creator'}`
      : `Tip ${curator?.username ? `@${curator.username}` : 'the curator'}`;

  return (
    // 🔴 NOT DISMISSIBLE WHILE A LEG IS IN FLIGHT. `Modal` closes on Escape, on
    // an overlay click and on its ×, and none of those cancel the POST that is
    // already on the wire: dismissing mid-transfer spends the Buzz and takes the
    // partial-failure UI (and with it the retry, and the plan) away. All three
    // affordances and Cancel are gated on the same `sending` flag, which is also
    // reported up so Player's own Escape handler agrees.
    <Modal
      opened
      onClose={onClose}
      title={title}
      size="sm"
      closeOnEscape={!sending}
      closeOnOverlayClick={!sending}
      withCloseButton={!sending}
    >
      <FocusTrap>
        <div data-testid="tip-split-modal" aria-label="Split a tip" style={bodyStyle}>
          {/* ---- what the viewer is buying ---- */}
          <p style={leadText}>
            {bothEligible
              ? 'One tip, divided between the creator of this media and the collection curator.'
              : eligibility.creatorEligible
                ? // Hazard 3, made visible: the curator leg is GONE, not disabled,
                  // and the copy says why rather than leaving a missing half.
                  'You curate this collection, so the whole tip goes to the creator of this media.'
                : 'This is your media, so the whole tip goes to the collection curator.'}
            {balance != null && ` · You have ${balance.toLocaleString()} Buzz.`}
          </p>

          <p style={leadText} data-testid="tip-split-allowance">
            {/* The ceiling is the SMALLER of the per-press total cap and what the
                server says is left in today's allowance — a real, server-read
                number since 0.2.10, not the localStorage estimate that tracked
                nothing. When the read has not resolved it is just the cap. */}
            Up to {ceiling.toLocaleString()} Buzz in total.
          </p>

          {/* ---- total ---- */}
          <div style={presetRow} role="group" aria-label="Preset amounts">
            {SPLIT_PRESETS.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={amount === String(p) ? 'filled' : 'light'}
                onClick={() => {
                  setAmount(String(p));
                  setTouched(true);
                }}
                aria-pressed={amount === String(p)}
                disabled={plan != null}
                data-testid={`split-preset-${p}`}
              >
                {p}
              </Button>
            ))}
          </div>

          <TextInput
            id="tip-split-amount"
            label="Total amount (Buzz)"
            inputMode="numeric"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setTouched(true);
            }}
            // 🔴 LOCKED ONCE A PLAN EXISTS. The plan's legs carry keys the server
            // has already seen; letting the amount change under a retry would ask
            // for a different transfer under a key that replays the first one.
            disabled={plan != null}
            error={error ? <span data-testid="split-error">{error}</span> : undefined}
            data-testid="split-amount-input"
            aria-label="Total tip amount in Buzz"
          />

          {/* ---- the split itself (only when both sides can receive) ---- */}
          {bothEligible && (
            <>
              <div style={presetRow} role="group" aria-label="Preset splits">
                {SPLIT_PERCENT_PRESETS.map((p) => (
                  <Button
                    key={p}
                    size="sm"
                    variant={creatorPercent === p ? 'filled' : 'light'}
                    onClick={() => {
                      setCreatorPercent(p);
                      setTouched(true);
                    }}
                    aria-pressed={creatorPercent === p}
                    disabled={plan != null}
                    data-testid={`split-percent-${p}`}
                  >
                    {p}/{100 - p}
                  </Button>
                ))}
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={creatorPercent}
                onChange={(v) => {
                  setCreatorPercent(v);
                  setTouched(true);
                }}
                disabled={plan != null}
                aria-label="Creator's share, percent"
                data-testid="split-percent"
              />
            </>
          )}

          {/* ---- the preview: exactly how much each side gets, before confirming ---- */}
          <div style={previewBox} data-testid="split-preview">
            {eligibility.creatorEligible && (
              <span data-testid="split-preview-creator">
                {creator?.username ? `@${creator.username}` : 'Creator'} (creator): {previewFor('creator').toLocaleString()} Buzz
              </span>
            )}
            {eligibility.curatorEligible && (
              <span data-testid="split-preview-curator">
                {curator?.username ? `@${curator.username}` : 'Curator'} (curator): {previewFor('curator').toLocaleString()} Buzz
              </span>
            )}
          </div>

          {/* ---- partial failure: what landed, what did not, and a retry ---- */}
          {failed && (
            <div style={partialBox} data-testid="split-partial" role="alert">
              {/* 🔴 SAME STANDARD AS THE DISCARD NOTE BELOW, AND IT HAD TO BE
                  APPLIED HERE TOO. This headline used to read "Part of that tip
                  did not go through." in EVERY failure state — making, in bolder
                  type and above the note, the exact unknowable claim the note was
                  just corrected to stop making. A leg marked `failed` may have
                  reached the server and lost only its reply, so "did not go
                  through" is not observable from in here. And in the
                  fully-failed state "Part of" was simply wrong: nothing was
                  confirmed, not merely some of it.

                  Both variants now claim only `status === 'sent'`, which is what
                  the app actually knows. Pinned verbatim by a test, for the same
                  reason the note is: this is money copy, and a keyword guard
                  walks past a reword. */}
              <strong style={{ fontSize: 13 }} data-testid="split-partial-headline">
                {nothingLanded
                  ? 'None of that tip came back confirmed.'
                  : 'Only part of that tip came back confirmed.'}
              </strong>
              {plan?.map((leg) => (
                <span key={leg.kind} data-testid={`split-leg-${leg.kind}`} data-status={leg.status}>
                  {leg.kind === 'creator' ? 'Creator' : 'Curator'}: {leg.amount.toLocaleString()} Buzz —{' '}
                  {leg.status === 'sent' ? 'sent' : 'not sent'}
                </span>
              ))}
              <span style={{ fontSize: 12 }} data-testid="split-partial-promise">
                {/* 🔴 WRITTEN FROM WHAT THE CODE DOES, AND THE SECOND SENTENCE IS
                    THE ONE THAT USED TO BE A LIE. `runPlan` skips sent legs and
                    re-sends an unsent one under its original key — true then and
                    now. But the plan lived in this component's own state, so the
                    Close button beside this text destroyed it and a re-confirm
                    minted fresh keys: the promise held only for the Retry button
                    and was void for its neighbour. The plan is now owned above
                    this component and keyed to the logical tip, which is exactly
                    as far as the second sentence claims — for as long as the page
                    stays open. Pinned verbatim by TipSplitModal.test.tsx. */}
                Retrying sends only what is still outstanding — the {sentLegs.length === 1 ? 'part' : 'parts'} already sent
                cannot be sent twice. Closing is safe too: reopening this split picks the same tip back up, for as long as
                this page stays open.
              </span>

              {/* ---- the way OUT of a tip where nothing landed ---- */}
              {nothingLanded && (
                <div style={discardBox}>
                  <span style={{ fontSize: 12 }} data-testid="split-discard-note">
                    {/* 🔴 WRITTEN FROM WHAT THE CODE DOES. Retry re-sends under the
                        ORIGINAL keys, so a transfer the server already took cannot
                        be taken again. Starting over throws those keys away and
                        mints new ones — which is safe only if none of these
                        transfers actually reached the server, and that is the one
                        thing this app cannot see from inside the iframe. Say so,
                        rather than presenting a free-looking reset.

                        🔴 THE FIRST CLAUSE SAID "Nothing went through" UNTIL AN
                        AUDIT CAUGHT IT, and it was the one sentence here that was
                        false. `nothingLanded` means no leg reached `sent` — i.e.
                        nothing came back CONFIRMED. A leg whose POST landed and
                        whose response was merely lost surfaces as an
                        `ApiError('network')` and is marked FAILED, so it is
                        counted by `nothingLanded` while the Buzz is already gone.
                        The paragraph then contradicted itself three sentences
                        later, and the false half was the half a viewer reads
                        first. The wording now claims only what the app can
                        observe. 🔴 It is pinned VERBATIM by a test, not by
                        keywords: a keyword guard is exactly what a reword like
                        this one walks past. */}
                    Nothing came back confirmed, so you can start over at a different amount — but Retry is the safer
                    button. Retrying re-sends these same transfers under their original keys, so anything the server
                    already took cannot be taken twice. Starting over throws those keys away: if one of these
                    transfers did reach the server and only its reply was lost, your new tip would become a second
                    transfer.
                  </span>
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={discard}
                    disabled={busy}
                    data-testid="split-discard"
                  >
                    Start a new tip
                  </Button>
                </div>
              )}
            </div>
          )}

          <div style={actionRow}>
            <Button variant="subtle" onClick={onClose} disabled={sending} data-testid="split-cancel">
              {failed ? 'Close' : 'Cancel'}
            </Button>
            {failed ? (
              <Button onClick={retry} loading={sending} disabled={busy} data-testid="split-retry">
                {sending ? 'Retrying…' : 'Retry'}
              </Button>
            ) : (
              <Button
                onClick={confirm}
                loading={busy}
                disabled={busy || Boolean(error) || plan != null}
                data-testid="split-confirm"
              >
                {busy ? 'Sending…' : `Send ${amount || '0'} Buzz`}
              </Button>
            )}
          </div>
        </div>
      </FocusTrap>
    </Modal>
  );
}

// ---- styles ----
const bodyStyle: CSSProperties = { display: 'grid', gap: 12 };
const leadText: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--civitai-color-text-dimmed)' };
const presetRow: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const actionRow: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' };
const previewBox: CSSProperties = {
  display: 'grid',
  gap: 4,
  padding: 10,
  borderRadius: 8,
  fontSize: 13,
  background: 'var(--civitai-color-surface-2)',
  border: '1px solid var(--civitai-color-border)',
};
/** The secondary escape, set apart from the Retry it must not compete with. */
const discardBox: CSSProperties = {
  display: 'grid',
  gap: 6,
  justifyItems: 'start',
  marginTop: 4,
  paddingTop: 8,
  borderTop: '1px solid var(--civitai-color-border)',
  color: 'var(--civitai-color-text-dimmed)',
};
const partialBox: CSSProperties = {
  display: 'grid',
  gap: 4,
  padding: 10,
  borderRadius: 8,
  fontSize: 13,
  background: 'var(--civitai-color-surface-2)',
  border: '1px solid var(--civitai-color-border)',
};
