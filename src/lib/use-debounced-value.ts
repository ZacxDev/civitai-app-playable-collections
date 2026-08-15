// Debounce a rapidly-changing value (e.g. a search box) so downstream work
// (a network fetch) fires only after the value settles.
//
// Used to make the collections search a LIVE type-ahead: the TextInput updates
// on every keystroke (immediate, controlled), but the list only re-fetches off
// the debounced value — no explicit Enter/Search press required.

import { useEffect, useState } from 'react';

/** Returns `value` delayed by `delayMs`, resetting the timer on each change. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}
