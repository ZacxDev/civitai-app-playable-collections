import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ModeSwitcher, SegmentedControl } from './ModeSwitcher.js';

describe('ModeSwitcher (SegmentedControl pack-gap)', () => {
  it('renders the three view modes as a radiogroup with the current one checked', () => {
    render(<ModeSwitcher value="classic" onChange={() => {}} />);
    const group = screen.getByTestId('mode-switcher');
    expect(group).toHaveAttribute('role', 'radiogroup');
    expect(screen.getByTestId('mode-switcher-classic')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('mode-switcher-continuous-horizontal')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('mode-switcher-continuous-vertical')).toHaveAttribute('aria-checked', 'false');
  });

  it('fires onChange with the picked mode', async () => {
    const onChange = vi.fn();
    render(<ModeSwitcher value="classic" onChange={onChange} />);
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    expect(onChange).toHaveBeenCalledWith('continuous-vertical');
  });

  it('marks the selected segment via data-selected + aria-checked', () => {
    render(<ModeSwitcher value="continuous-horizontal" onChange={() => {}} />);
    expect(screen.getByTestId('mode-switcher-continuous-horizontal')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('mode-switcher-classic')).toHaveAttribute('data-selected', 'false');
  });
});

describe('SegmentedControl (generic)', () => {
  it('renders arbitrary options and reports the chosen value', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        value="a"
        onChange={onChange}
        ariaLabel="Letters"
        testid="letters"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    expect(screen.getByTestId('letters')).toHaveAttribute('aria-label', 'Letters');
    await userEvent.click(screen.getByTestId('letters-b'));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
