import type { ReactNode } from 'react';

import { Harness as SdkHarness } from '@civitai/blocks-react/testing';

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
  return <SdkHarness viewer={{ id: 99, username: 'me' }}>{children}</SdkHarness>;
}
