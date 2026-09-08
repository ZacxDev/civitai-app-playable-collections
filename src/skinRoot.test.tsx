// `data-pc-skin` is the switch that makes src/skin.css apply at all.
//
// 🔴 THE FAILURE THIS GUARDS IS SILENT AND COMPLETE. skin.css scopes every token
// override to `[data-pc-skin][data-theme…]` — a compound selector, because a bare
// one would tie with @civitai/theme's `[data-theme='dark']` and lose on source
// order. So a root rendered WITHOUT the attribute does not fall back gracefully:
// it reverts to the platform's blue-grey, in full, while the stylesheet is loaded
// and looks fine, no console error, no failed request, and every other test in
// this repo still green. That is the "an inert config key reads as enabled and
// does nothing" shape — the cure is to assert the RENDERED output, not the file.
//
// Two assertions, deliberately of different kinds:
//   • behavioural — the root React actually commits carries both attributes, in
//     both themes. This is the one that would have caught the bug.
//   • a structural LEDGER — every `data-theme` root in App.tsx is also a
//     `data-pc-skin` root, and there are exactly as many as we think. It covers
//     the roots the DOM tier cannot drive into, and fails if the set GROWS or
//     SHRINKS. 🔴 That half lives in src/skin.test.ts, NOT here: this file runs in
//     the `dom` (jsdom) project, where `import.meta.url` is an http: URL and
//     `fileURLToPath` throws — a source-reading test belongs in the `node`
//     project. Both projects run under a bare `pnpm test`; check both are green.
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import { createFakeApi } from './fake-api.js';

function renderApp(theme: 'light' | 'dark') {
  return render(
    <Harness viewer={{ id: 99, username: 'me' }} theme={theme} showLog={false}>
      <App api={createFakeApi({ viewerUserId: 99, balance: 5000 })} />
    </Harness>,
  );
}

describe('the skin switch is actually on the committed root', () => {
  it.each(['dark', 'light'] as const)('%s: the app root carries data-pc-skin AND data-theme', async (theme) => {
    const { container } = renderApp(theme);
    // Wait for the post-BLOCK_INIT commit so this is the browse root, not boot.
    await waitFor(() => expect(screen.getByTestId('tab-discover')).toBeInTheDocument());

    const roots = container.querySelectorAll('[data-theme]');
    expect(roots.length).toBeGreaterThan(0); // positive control: we found a root

    const root = roots[0] as HTMLElement;
    expect(root.getAttribute('data-theme')).toBe(theme);
    // The whole point: present, on the SAME element as data-theme. A skin scoped
    // to `[data-pc-skin][data-theme…]` matches nothing if they are split across
    // an ancestor and a descendant.
    expect(root.hasAttribute('data-pc-skin')).toBe(true);
  });

  it('the boot root carries it too — it paints before any other root exists', async () => {
    // Rendered with no host at all: `ready` never flips, so App stays on the
    // `!ready || !canFetch` branch, which is a DIFFERENT root element from the
    // one above and the first thing a real viewer sees.
    const { container } = render(<App api={createFakeApi({ viewerUserId: 99, balance: 0 })} />);
    const root = container.querySelector('[data-theme]');
    expect(root).not.toBeNull();
    expect(root!.hasAttribute('data-pc-skin')).toBe(true);
  });
});

