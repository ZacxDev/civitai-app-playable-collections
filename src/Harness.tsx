import type { ReactNode } from 'react';

import { Harness as SdkHarness } from '@civitai/blocks-react/testing';

import manifest from '../block.manifest.json';

/**
 * Local dev mock host for the Playable Collections PAGE app.
 *
 * The real W10 page surface mounts the block in a full-bleed iframe at
 * /apps/run/playable-collections and brokers the protocol (BLOCK_INIT, viewer,
 * settings). Locally there's no host, so the published SDK mock host plays one.
 *
 * NOTE: the SDK mock host answers BLOCK_INIT + viewer/consent but does NOT
 * answer any of the block HTTP endpoints (collections, tip, follow, buzz,
 * shared storage). So the dev harness (main.tsx) injects an in-memory fake
 * ApiClient at the App boundary for all of those — the real HTTP path
 * (createHttpApiClient) is used only against a live civitai host.
 */
export function Harness({ children }: { children: ReactNode }) {
  // Dev-only: let `?theme=light|dark` on the harness URL drive the mock host's
  // theme so both themes can be exercised (and screenshotted) with no code change.
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  return (
    // `declaredScopes` is the mock host's picture of the MANIFEST — its
    // reaction gate refuses every call `needs-consent` unless
    // `social:react:self` is among the declared scopes, exactly as the real
    // host refuses an undeclared scope. Hand it the app's real declaration
    // (the SDK's own documented usage) so dev exercises the declared set,
    // not a copy of it that can drift.
    //
    // `reactionStates` seeds the bridge state for the fake API's item ids
    // (1001… in collection 1): counts on the first items and one reaction
    // the dev viewer already holds, so the player's pressed state renders
    // on first open instead of a row of zeros.
    <SdkHarness
      viewer={{ id: 99, username: 'me' }}
      theme={theme}
      declaredScopes={manifest.scopes}
      reactionStates={{
        1001: { counts: { Like: 12, Heart: 5, Laugh: 2, Cry: 0 }, viewerReactions: ['Heart'] },
        1002: { counts: { Like: 3, Heart: 1, Laugh: 0, Cry: 0 } },
        1003: { counts: { Like: 0, Heart: 0, Laugh: 0, Cry: 1 } },
      }}
    >
      {children}
    </SdkHarness>
  );
}
