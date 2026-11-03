'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';

// Per-browser view preferences (grouping, sort, filters) in localStorage.
// useSyncExternalStore renders the default on the server and the stored value
// after hydration, without an effect-then-setState flash of mismatched markup.

const EVENT = 'tab-enter:stored-state';
/** Used when localStorage is blocked, so choices still apply for this page view. */
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function subscribe(callback: () => void) {
  window.addEventListener('storage', callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(EVENT, callback);
  };
}

export function useStoredState<T>(key: string, fallback: T): [T, (value: T) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const value = useMemo<T>(() => {
    if (raw === null) return fallback;
    try {
      // Merge so fields added later get their defaults.
      const parsed = JSON.parse(raw) as T;
      return fallback && typeof fallback === 'object' && !Array.isArray(fallback)
        ? { ...fallback, ...parsed }
        : parsed;
    } catch {
      return fallback;
    }
    // fallback is a constant at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  const set = useCallback(
    (next: T) => {
      const json = JSON.stringify(next);
      memory.set(key, json);
      try {
        window.localStorage.setItem(key, json);
      } catch {
        // storage unavailable: the choice just won't be remembered
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [value, set];
}
