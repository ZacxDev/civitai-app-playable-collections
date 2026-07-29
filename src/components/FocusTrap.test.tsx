import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { FocusTrap } from './FocusTrap.js';

describe('FocusTrap', () => {
  it('wraps Tab from the last focusable back to the first', async () => {
    render(
      <FocusTrap>
        <button data-testid="a">A</button>
        <button data-testid="b">B</button>
        <button data-testid="c">C</button>
      </FocusTrap>,
    );
    screen.getByTestId('c').focus();
    expect(screen.getByTestId('c')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByTestId('a')).toHaveFocus();
  });

  it('wraps Shift+Tab from the first focusable to the last', async () => {
    render(
      <FocusTrap>
        <button data-testid="a">A</button>
        <button data-testid="b">B</button>
        <button data-testid="c">C</button>
      </FocusTrap>,
    );
    screen.getByTestId('a').focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByTestId('c')).toHaveFocus();
  });

  it('autoFocuses the first control when asked', () => {
    render(
      <FocusTrap autoFocus>
        <button data-testid="a">A</button>
        <button data-testid="b">B</button>
      </FocusTrap>,
    );
    expect(screen.getByTestId('a')).toHaveFocus();
  });

  it('restores focus to the previously-focused element on unmount', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button data-testid="trigger" onClick={() => setOpen(true)}>
            open
          </button>
          {open && (
            <FocusTrap autoFocus restoreFocus>
              <button data-testid="inner" onClick={() => setOpen(false)}>
                close
              </button>
            </FocusTrap>
          )}
        </div>
      );
    }
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(trigger).toHaveFocus();
    // Open (trap mounts, saves the trigger, autofocuses inner).
    await userEvent.click(trigger);
    expect(screen.getByTestId('inner')).toHaveFocus();
    // Close (trap unmounts → focus restored to the trigger).
    await userEvent.click(screen.getByTestId('inner'));
    expect(screen.getByTestId('trigger')).toHaveFocus();
  });
});
