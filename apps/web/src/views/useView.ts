import { useCallback, useEffect, useState } from 'react';
import { loadView, type ViewData, type ViewResult, type ViewRoute } from '../data/views';
import { formatRoute } from '../route';

/**
 * Load a view for a route. `reload()` refetches in place: the previous data stays on screen
 * until the new response arrives (used after a manual label is saved).
 */
export function useView<R extends ViewRoute>(route: R, days: number) {
  const key = `${formatRoute(route)}|${days}`;
  const [state, setState] = useState<{ key: string; result: ViewResult<ViewData<R>> } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void loadView(route, days).then((result) => {
      if (live) setState({ key, result });
    });
    return () => {
      live = false;
    };
    // route identity changes every render; the key captures it
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const result = state && state.key === key ? state.result : null;
  return { result, reload };
}
