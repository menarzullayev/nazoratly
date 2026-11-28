import { useCallback, useEffect, useRef, useState } from "react";
import { newKey } from "../api/client";
import { ApiFailure } from "../api/errors";

export const asFailure = (error: unknown): ApiFailure =>
  error instanceof ApiFailure ? error : new ApiFailure(0, "unknown", String(error), null);

export interface Load<T> {
  data: T | undefined;
  error: ApiFailure | null;
  loading: boolean;
  reload: () => void;
}

/** Loads when `deps` change; a late answer to an older request is dropped. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[]): Load<T> {
  const [state, setState] = useState<{ data: T | undefined; error: ApiFailure | null; loading: boolean }>({
    data: undefined,
    error: null,
    loading: true,
  });
  const [turn, setTurn] = useState(0);
  const run = useRef(fetcher);
  run.current = fetcher;
  const key = JSON.stringify(deps);
  useEffect(() => {
    let wanted = true;
    setState((s) => ({ ...s, error: null, loading: true }));
    run.current().then(
      (data) => wanted && setState({ data, error: null, loading: false }),
      (error: unknown) => wanted && setState({ data: undefined, error: asFailure(error), loading: false }),
    );
    return () => {
      wanted = false;
    };
  }, [key, turn]);
  return { ...state, reload: useCallback(() => setTurn((n) => n + 1), []) };
}

/** One action at a time: a second click while the first request runs does nothing. `run` hands the action an
 * Idempotency-Key that stays the same until the action succeeds, so a retry after a lost answer repeats nothing. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const busy = useRef(false);
  const key = useRef<string | null>(null);
  const run = useCallback(async (action: (idempotencyKey: string) => Promise<void>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    key.current ??= newKey();
    try {
      await action(key.current);
      key.current = null;
      return true;
    } catch (failure) {
      const known = asFailure(failure);
      // the server answered and refused: it released the key, and a corrected request needs a fresh one
      if (known.status >= 400 && known.status < 500 && known.status !== 409) key.current = null;
      setError(known);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);
  return { pending, error, run, clear: useCallback(() => setError(null), []) };
}

/** `value` after it has stopped changing for a moment (search boxes). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [slow, setSlow] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return slow;
}
