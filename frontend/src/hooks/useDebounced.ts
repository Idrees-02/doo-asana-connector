import { useEffect, useState } from 'react';

/**
 * Debounce a rapidly-changing value.
 *
 * Used for search inputs so filtering does not re-run on every keystroke. The
 * timer is cleared on change and on unmount, so a pending update cannot fire
 * against an unmounted component.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
