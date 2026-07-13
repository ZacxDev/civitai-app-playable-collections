import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import type { ViewerInfo } from '@civitai/app-sdk/blocks';

import { App } from './App.js';
import { CollectionGrid } from './components/CollectionGrid.js';
import { ApiError, type ApiClient } from './lib/api.js';
import { createFakeApi } from './fake-api.js';
import { palette } from './theme.js';
import type { CollectionSummary } from './types.js';
import { setViewport } from './test-setup.js';

function renderApp(
  opts: {
    api: ApiClient;
    viewer?: ViewerInfo | null;
    theme?: 'light' | 'dark';
    isPrivateGranted?: (scopes: string[]) => boolean;
    onOutbound?: (msg: { type: string; payload?: unknown }) => void;
  } = { api: createFakeApi() },
) {
  return render(
    <Harness
      viewer={opts.viewer === undefined ? { id: 99, username: 'me' } : opts.viewer}
      theme={opts.theme ?? 'dark'}
      showLog={false}
      onOutbound={opts.onOutbound}
    >
      <App api={opts.api} isPrivateGranted={opts.isPrivateGranted} />
    </Harness>,
  );
}

const c = palette(true);

const sampleCollection = (over: Partial<CollectionSummary> = {}): CollectionSummary => ({
  id: 1,
  name: 'Sample',
  description: null,
  coverImageUrl: null,
  itemCount: 3,
  curator: { userId: 5, username: 'curator' },
  isPublic: true,
  followed: false,
  ...over,
});

describe('CollectionGrid states (deterministic)', () => {
  it('renders a loading state', () => {
    render(<CollectionGrid collections={[]} loading error={null} emptyLabel="none" onOpen={() => {}} c={c} isMobile={false} />);
    expect(screen.getByTestId('grid-loading')).toBeInTheDocument();
  });

  it('renders an error state with a retry button', async () => {
    const onRetry = vi.fn();
    render(
      <CollectionGrid collections={[]} loading={false} error="Boom" emptyLabel="none" onOpen={() => {}} onRetry={onRetry} c={c} isMobile={false} />,
    );
    expect(screen.getByTestId('grid-error')).toHaveTextContent('Boom');
    await userEvent.click(screen.getByTestId('grid-retry'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders an empty state', () => {
    render(<CollectionGrid collections={[]} loading={false} error={null} emptyLabel="Nothing here" onOpen={() => {}} c={c} isMobile={false} />);
    expect(screen.getByTestId('grid-empty')).toHaveTextContent('Nothing here');
  });

  it('renders cards and fires onOpen', async () => {
    const onOpen = vi.fn();
    render(
      <CollectionGrid collections={[sampleCollection({ name: 'Neon' })]} loading={false} error={null} emptyLabel="" onOpen={onOpen} c={c} isMobile={false} />,
    );
    await userEvent.click(screen.getByTestId('collection-card'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'Neon' }));
  });

  it('branches its layout on isMobile', () => {
    const { rerender } = render(
      <CollectionGrid collections={[sampleCollection()]} loading={false} error={null} emptyLabel="" onOpen={() => {}} c={c} isMobile />,
    );
    expect(screen.getByTestId('collection-grid')).toHaveAttribute('data-layout', 'mobile');
    rerender(
      <CollectionGrid collections={[sampleCollection()]} loading={false} error={null} emptyLabel="" onOpen={() => {}} c={c} isMobile={false} />,
    );
    expect(screen.getByTestId('collection-grid')).toHaveAttribute('data-layout', 'desktop');
  });

  it('shows private + followed badges', () => {
    render(
      <CollectionGrid
        collections={[sampleCollection({ isPublic: false, followed: true })]}
        loading={false}
        error={null}
        emptyLabel=""
        onOpen={() => {}}
        c={c}
        isMobile={false}
      />,
    );
    expect(screen.getByTestId('private-badge')).toBeInTheDocument();
    expect(screen.getByTestId('followed-badge')).toBeInTheDocument();
  });
});

describe('App — discover + tabs', () => {
  it('loads and shows public collections on the discover tab', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api });
    // discover shows the 3 public seed collections (2 others + own public board)
    const grid = await screen.findByTestId('collection-grid');
    const cards = within(grid).getAllByTestId('collection-card');
    expect(cards).toHaveLength(3);
    expect(grid).toHaveTextContent('Neon Cities');
    expect(grid).toHaveTextContent('Forest Studies');
    expect(grid).toHaveTextContent('My Public Board');
  });

  it('shows the viewer Buzz balance once loaded', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 1234 });
    renderApp({ api });
    await waitFor(() => expect(screen.getByTestId('buzz-balance')).toHaveTextContent('1,234'));
  });

  it('switches to My collections and shows own public + private when private access is granted', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api, isPrivateGranted: () => true });
    await screen.findByTestId('collection-grid');
    await userEvent.click(screen.getByTestId('tab-mine'));
    const grid = await screen.findByTestId('collection-grid');
    await waitFor(() => expect(within(grid).getAllByTestId('collection-card')).toHaveLength(2));
    expect(grid).toHaveTextContent('My Public Board');
    expect(grid).toHaveTextContent('My Private Board');
    // granted => no consent affordance
    expect(screen.queryByTestId('private-consent')).not.toBeInTheDocument();
  });

  it('prompts sign-in on My collections when anonymous', async () => {
    const api = createFakeApi();
    renderApp({ api, viewer: null });
    await screen.findByTestId('collection-grid');
    await userEvent.click(screen.getByTestId('tab-mine'));
    expect(await screen.findByTestId('mine-anon')).toBeInTheDocument();
  });

  it('surfaces a list error with retry', async () => {
    const base = createFakeApi();
    let fail = true;
    const api: ApiClient = {
      ...base,
      async listCollections(params) {
        if (params.mode === 'public' && fail) throw new ApiError('forbidden', 403, 'No access');
        return base.listCollections(params);
      },
    };
    renderApp({ api });
    expect(await screen.findByTestId('grid-error')).toHaveTextContent('No access');
    fail = false;
    await userEvent.click(screen.getByTestId('grid-retry'));
    await screen.findByTestId('collection-grid');
  });
});

describe('App — responsive root branch', () => {
  it('marks the root layout mobile vs desktop', async () => {
    setViewport('mobile');
    const api = createFakeApi();
    const { unmount } = renderApp({ api });
    await screen.findByTestId('collection-grid');
    expect(document.querySelector('[data-layout="mobile"]')).toBeTruthy();
    unmount();

    setViewport('desktop');
    renderApp({ api: createFakeApi() });
    await screen.findByTestId('collection-grid');
    expect(document.querySelector('[data-layout="desktop"]')).toBeTruthy();
  });
});

describe('App — private collections consent gate', () => {
  async function gotoMine() {
    await screen.findByTestId('collection-grid');
    await userEvent.click(screen.getByTestId('tab-mine'));
    // wait for the mine list to load (public own board present)
    await screen.findByText('My Public Board');
  }

  it('hides private collections and shows the consent affordance when not granted', async () => {
    // Default App predicate keys off the REAL scope, which the mock host never
    // grants — models "not yet granted". Fake mirrors the server: private hidden.
    const api = createFakeApi({ viewerUserId: 99, collectionsPrivateGranted: () => false });
    renderApp({ api }); // no isPrivateGranted override
    await gotoMine();

    expect(screen.getByTestId('private-consent')).toBeInTheDocument();
    expect(screen.getByText('My Public Board')).toBeInTheDocument();
    expect(screen.queryByText('My Private Board')).not.toBeInTheDocument();
    // graceful: no error surface
    expect(screen.queryByTestId('grid-error')).not.toBeInTheDocument();
  });

  it('the affordance sends a REQUEST_CONSENT for collections:read:private (declined path stays public-only, no error)', async () => {
    const outbound: Array<{ type: string; payload?: unknown }> = [];
    const api = createFakeApi({ viewerUserId: 99, collectionsPrivateGranted: () => false });
    // Default predicate => the mock host's grant (ai:write:budgeted) does NOT map
    // to the private scope, so this models the host NOT granting (decline).
    renderApp({ api, onOutbound: (m) => outbound.push(m) });
    await gotoMine();

    await userEvent.click(screen.getByTestId('enable-private'));

    const consentMsg = outbound.find((m) => m.type === 'REQUEST_CONSENT');
    expect(consentMsg).toBeTruthy();
    expect(consentMsg?.payload).toMatchObject({ scopes: ['collections:read:private'] });

    // Declined / not granted: private still hidden, affordance persists, no error.
    await waitFor(() => expect(screen.getByTestId('private-consent')).toBeInTheDocument());
    expect(screen.queryByText('My Private Board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('grid-error')).not.toBeInTheDocument();
  });

  it('after grant + token re-mint, private collections appear and the affordance disappears', async () => {
    // The mock host grants `ai:write:budgeted` on REQUEST_CONSENT and re-mints
    // the token (TOKEN_REFRESH). We map that grant to the private scope, and flip
    // the fake server to reveal private on the same consent event — a true
    // request -> re-mint -> observe -> reload round-trip.
    let granted = false;
    const api = createFakeApi({ viewerUserId: 99, collectionsPrivateGranted: () => granted });
    renderApp({
      api,
      isPrivateGranted: (scopes) => scopes.includes('ai:write:budgeted'),
      onOutbound: (m) => {
        if (m.type === 'REQUEST_CONSENT') granted = true;
      },
    });
    await gotoMine();

    // before consent: private hidden, affordance shown
    expect(screen.getByTestId('private-consent')).toBeInTheDocument();
    expect(screen.queryByText('My Private Board')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('enable-private'));

    // after grant + re-mint: private appears, affordance gone
    expect(await screen.findByText('My Private Board')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('private-consent')).not.toBeInTheDocument());
    expect(screen.getByText('My Public Board')).toBeInTheDocument();
  });
});
