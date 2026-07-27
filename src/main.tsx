import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BlockGate, injectBlocksStyles } from '@civitai/blocks-react/ui';

// Design-system tokens (`--civitai-*` custom properties, light/dark via
// `[data-theme]`). The pack's injectBlocksStyles() also injects these at runtime,
// but importing the stylesheet makes @civitai/theme an explicit, first-paint
// token source rather than a transitive side-effect of the pack.
import '@civitai/theme/styles.css';

import { App } from './App.js';
import { Harness } from './Harness.js';
import { installHarnessTransport } from './dev-transport.js';
import { createFakeApi } from './fake-api.js';
import './index.css';

// Inject the /ui pack's themed stylesheet once up-front (idempotent; the pack
// components also self-inject on first render — this just guarantees tokens +
// component styles exist before the first paint).
injectBlocksStyles();

// `npm run dev:harness` sets VITE_DEV_HARNESS=true to mount the local mock host
// (the published `@civitai/blocks-react/testing` Harness) that posts a fake
// BLOCK_INIT + answers the viewer/consent protocol. The mock host does NOT
// answer the block HTTP endpoints, so in dev we inject a fake in-memory
// ApiClient at the App boundary — separate from the real HTTP path (which App
// uses via createHttpApiClient() when no api is injected). Never set
// VITE_DEV_HARNESS in prod.
const useHarness = import.meta.env.VITE_DEV_HARNESS === 'true';

// The mock host replies from window.location.origin; the SDK transport drops
// mismatched-origin messages. Allowlist this origin BEFORE any hook runs.
if (useHarness) installHarnessTransport();

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

// Dev-only in-memory API (viewer id 99 matches the Harness viewer) so the
// harness discover/play/tip/follow loop works with no backend.
const devApi = useHarness ? createFakeApi({ viewerUserId: 99, balance: 5000 }) : undefined;

// `<BlockGate>` shows an "Open on Civitai" landing when the block is loaded
// DIRECTLY (top-level at its bare `<slug>.civit.ai` origin, no BLOCK_INIT)
// instead of hanging on the app's loading state. It's inert on the embedded
// happy path and the dev harness (both post BLOCK_INIT), so it renders the app
// unchanged there.
createRoot(container).render(
  <StrictMode>
    <BlockGate>
      {useHarness ? (
        <Harness>
          <App api={devApi} />
        </Harness>
      ) : (
        <App />
      )}
    </BlockGate>
  </StrictMode>,
);
