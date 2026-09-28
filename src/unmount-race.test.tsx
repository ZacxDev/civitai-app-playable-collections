// ---------------------------------------------------------------------------
// 🔴 A LOADER THAT SETTLES AFTER UNMOUNT MUST NOT WRITE STATE
// ---------------------------------------------------------------------------
//
// This pins the defect CI caught on the `@civitai/sdk` port and this host's
// local run structurally could not: `App`'s three feed loaders guard their
// `setState` calls with a SEQUENCE number (`seq !== …SeqRef.current`), which
// answers "is this response stale?" and says nothing about "is the component
// still mounted?". Ten guard sites, none of them a mount check.
//
// Why it stayed invisible until the port: these loaders used to read through the
// `postMessage` bridge, which settled fast enough that the race was rarely lost.
// The port routes them over REST, which is slow enough to lose — so a response
// can land after a test has unmounted and vitest has torn the jsdom environment
// down. React 19 reads `window` in `resolveUpdatePriority` on the way into
// `dispatchSetState`, so that late write throws `ReferenceError: window is not
// defined`.
//
// 🔴 AND THE SHAPE OF THE FAILURE IS WHY THIS TEST EXISTS RATHER THAN A CI RE-READ.
// Because the throw happens inside an `await`, it surfaces as an UNHANDLED
// REJECTION, not a failing assertion: vitest prints `63 passed (63)` / `822
// passed (822)` and one `Errors 1 error`, then exits 1. Every test passes and the
// suite is red, which reads as infrastructure noise rather than a defect in
// `App.tsx` — the CI log blamed `reduced-motion.test.tsx`, a file that has
// nothing to do with the popular rail and merely happened to be running.
//
// So the assertion below is on `unhandledRejection`, deliberately. An assertion
// on rendered output could not see this at all: by the time it goes wrong the
// component is gone.

import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import { createFakeApi } from './fake-api.js';
import type { ApiClient } from './lib/api.js';
import { configureSdkRuntime } from './lib/sdk-runtime.js';

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('a feed loader that settles after unmount', () => {
  it('writes no state once the component is gone and the environment is torn down', async () => {
    // Hold the shared-storage read open, so the popular loader is provably still
    // in flight at the moment we unmount.
    let release!: (body: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let reachedSharedStorage = false;

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('shared-storage')) {
        reachedSharedStorage = true;
        const body = await pending;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    // `fetch` is the seam the port creates: shared storage is HTTP now, so the
    // mock HOST never sees these calls and seeding the host would exercise nothing.
    configureSdkRuntime({ fetch: fetchImpl });

    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => void rejections.push(err);
    process.on('unhandledRejection', onRejection);

    const realWindow = globalThis.window;
    try {
      const { unmount } = render(
        <Harness viewer={{ id: 99, username: 'me' }} theme="dark" showLog={false}>
          <App
            api={createFakeApi({ viewerUserId: 99 }) as unknown as ApiClient}
            isTipGranted={() => true}
          />
        </Harness>,
      );

      // 🔴 POSITIVE CONTROL. Without it this test passes when the loader never
      // starts — a request that was never issued cannot settle late, so the
      // assertion at the end would hold for the wrong reason and keep holding if
      // someone deleted the rail entirely.
      await waitFor(() => expect(reachedSharedStorage).toBe(true));

      unmount();

      // Reproduce the teardown, which is the half that makes the write THROW
      // rather than merely being a no-op: vitest disposes the jsdom environment
      // after a test, so `window` is already gone when a late promise settles.
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'window');

      release({ entries: [] });
      // Let the continuation and any rejection it raises be delivered.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toEqual([]);
    } finally {
      // Restore BEFORE the shared `afterEach` runs — `cleanup()` needs a window.
      if (realWindow) {
        Object.defineProperty(globalThis, 'window', {
          value: realWindow,
          configurable: true,
          writable: true,
        });
      }
      process.off('unhandledRejection', onRejection);
    }
  });
});
