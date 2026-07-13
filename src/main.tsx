import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { Harness } from './Harness.js';
import { installHarnessTransport } from './dev-transport.js';
import { createFakeApi } from './fake-api.js';
import './index.css';

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

createRoot(container).render(
  <StrictMode>
    {useHarness ? (
      <Harness>
        <App api={devApi} />
      </Harness>
    ) : (
      <App />
    )}
  </StrictMode>,
);
