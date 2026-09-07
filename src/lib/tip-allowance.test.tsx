// `useServerTipAllowance` — the ONE server allowance read a view holds.
//
// A .test.tsx on purpose: vite.config.ts routes `src/**/*.test.ts` to the
// DOM-less `node` project, where every case of a hook test fails on a missing
// document and reads exactly like broken tests.

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useServerTipAllowance } from './tip-allowance.js';
import type { ApiClient } from './api.js';
import type { TipAllowance } from '../types.js';

/** A probe that renders the hook's output so a test can read it off the DOM. */
function Probe({ api }: { api: Pick<ApiClient, 'getTipAllowance'> | null }) {
  const { remaining, refetch } = useServerTipAllowance(api);
  return (
    <div>
      <span data-testid="remaining">{remaining === null ? 'unknown' : String(remaining)}</span>
      <button type="button" onClick={refetch} data-testid="refetch">
        refetch
      </button>
    </div>
  );
}

function allowanceClient(impl: () => Promise<TipAllowance>) {
  const getTipAllowance = vi.fn(impl);
  return { api: { getTipAllowance } as Pick<ApiClient, 'getTipAllowance'>, getTipAllowance };
}

describe('useServerTipAllowance', () => {
  it('reads the server figure once and reports its `remaining`', async () => {
    const { api, getTipAllowance } = allowanceClient(async () => ({ cap: 25000, spent: 4000, remaining: 21000 }));
    render(<Probe api={api} />);
    expect(await screen.findByText('21000')).toBeInTheDocument();
    expect(getTipAllowance).toHaveBeenCalledTimes(1);
  });

  it('does NOT fetch before a client exists', async () => {
    render(<Probe api={null} />);
    // No client => nothing to call, and the allowance stays unknown rather than 0.
    expect(screen.getByTestId('remaining')).toHaveTextContent('unknown');
  });

  it('re-reads on `refetch` — the post-tip path', async () => {
    let remaining = 21000;
    const { api, getTipAllowance } = allowanceClient(async () => ({ cap: 25000, spent: 25000 - remaining, remaining }));
    render(<Probe api={api} />);
    expect(await screen.findByText('21000')).toBeInTheDocument();
    // The server debits a tip; the next read must show the new figure.
    remaining = 20950;
    await userEvent.click(screen.getByTestId('refetch'));
    expect(await screen.findByText('20950')).toBeInTheDocument();
    expect(getTipAllowance).toHaveBeenCalledTimes(2);
  });

  it('🔴 a FAILED read degrades to UNKNOWN, never to 0', async () => {
    // The whole hazard: reporting 0 on a failed read would pre-block every tip
    // locally for a viewer whose real allowance is untouched. `null` means "no
    // local pre-block"; App maps it to `undefined`, whose picker default is the
    // full cap, so the server stays the only gate.
    const { api } = allowanceClient(async () => {
      throw new Error('offline');
    });
    render(<Probe api={api} />);
    await act(async () => {});
    expect(screen.getByTestId('remaining')).toHaveTextContent('unknown');
    expect(screen.getByTestId('remaining')).not.toHaveTextContent('0');
  });

  it('clamps a negative server `remaining` to 0', async () => {
    // The server's figure is reservation-based and can briefly over-count; a
    // negative would render as a nonsense ceiling in the picker.
    const { api } = allowanceClient(async () => ({ cap: 25000, spent: 25050, remaining: -50 }));
    render(<Probe api={api} />);
    expect(await screen.findByText('0')).toBeInTheDocument();
  });
});
