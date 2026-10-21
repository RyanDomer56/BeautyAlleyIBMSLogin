/**
 * A minimal data-fetching hook.
 *
 * Every console page needs the same four things: a loading flag, the data, an
 * error, and a way to try again. This is that, once.
 *
 * The API is `useAsync(key, fn)` rather than the more familiar
 * `useAsync(fn, deps)`. The reason is stale closures: with a deps array the
 * `fn` captured at effect time is whatever `fn` was on that render, so a
 * handler that closes over changing state silently reads old values. Keying on
 * a string and reading `fn` from a ref means the effect re-runs exactly when
 * the key changes, and always calls the *current* function.
 *
 * A late response from a superseded request is dropped rather than allowed to
 * overwrite a newer one — without that, typing in a search box makes results
 * flicker backwards.
 */

import * as React from "react";

import { ApiError } from "./api";

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True only for the very first load, so a refetch can keep the old rows up. */
  initial: boolean;
  reload: () => void;
}

export function useAsync<T>(key: string, fn: () => Promise<T>): AsyncState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  const seen = React.useRef(0);

  const fnRef = React.useRef(fn);
  fnRef.current = fn;

  // Which key the data currently on screen belongs to.
  const keyRef = React.useRef(key);

  React.useEffect(() => {
    const ticket = ++seen.current;
    const keyChanged = keyRef.current !== key;
    keyRef.current = key;

    setLoading(true);

    // A new key means a different record. Keeping the previous result visible
    // while the next request is in flight showed the *old* client's details
    // under the newly selected one - the stale-detail bug on the clients and
    // team pages, where a slow response left the wrong person on screen with
    // nothing to indicate it was stale.
    //
    // Deliberately only on a key change: `reload()` keeps the current rows up
    // so a refresh does not blank the table.
    if (keyChanged) {
      setData(null);
      setError(null);
    }

    fnRef
      .current()
      .then((result) => {
        if (ticket !== seen.current) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ticket !== seen.current) return;
        setError(
          err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", String((err as Error)?.message ?? err)),
        );
      })
      .finally(() => {
        if (ticket !== seen.current) return;
        setLoading(false);
      });
  }, [key, nonce]);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, initial: loading && data === null, reload };
}
