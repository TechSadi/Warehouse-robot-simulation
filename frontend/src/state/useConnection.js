import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getHealth } from '../api/client.js';
import { realtime, CONNECTION } from '../api/realtime.js';

/**
 * The two connections this app depends on, kept separate on purpose.
 *
 * They used to be one `connectionStatus` string fed by both the /health
 * poll and the socket's connect/disconnect events, which produced a status
 * that was reliably wrong: losing the socket set it to "offline" even
 * though every REST call still worked, and ten seconds later the health
 * poll set it back to "online" while the live view was still dead. A
 * person reading that pill could not tell whether their robots had stopped
 * moving or the label was just lying. They are different facts about
 * different transports, so they are reported as two.
 */

/**
 * The realtime lifecycle, read straight from the connection manager.
 *
 * `useSyncExternalStore` is the right primitive here rather than a
 * `useState` + effect pair: the manager is the source of truth, its state
 * object is replaced (never mutated) on change, and this subscribes to it
 * without an intermediate copy that could render a value the manager has
 * already moved past.
 */
export function useRealtimeStatus() {
  return useSyncExternalStore(
    useCallback((listener) => realtime.subscribe(listener), []),
    useCallback(() => realtime.getState(), []),
    // Server-render / prerender snapshot. No socket exists there.
    useCallback(() => realtime.getState(), [])
  );
}

const HEALTH_INTERVAL_MS = 10000;

export const API_HEALTH = {
  CHECKING: 'checking',
  ONLINE: 'online',
  OFFLINE: 'offline',
};

/**
 * Polls the API's health endpoint while `enabled`.
 *
 * Pauses while the tab is hidden - a background dashboard has no one
 * reading its status pill, and every skipped poll is a request the server
 * does not have to serve - and re-checks immediately on becoming visible
 * again so the first thing a returning user sees is current.
 */
export function useApiHealth(enabled) {
  const [health, setHealth] = useState(API_HEALTH.CHECKING);
  const inFlight = useRef(null);

  const check = useCallback(async () => {
    // One outstanding probe at a time: a slow/hanging health request must
    // not stack up behind the interval and turn a struggling server into an
    // unresponsive one.
    if (inFlight.current) return inFlight.current;
    const controller = new AbortController();
    const probe = getHealth({ signal: controller.signal })
      .then(() => setHealth(API_HEALTH.ONLINE))
      .catch((err) => {
        if (err?.name !== 'AbortError') setHealth(API_HEALTH.OFFLINE);
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = probe;
    return probe;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setHealth(API_HEALTH.CHECKING);
      return undefined;
    }

    let interval = null;

    function start() {
      check();
      if (interval === null) interval = setInterval(check, HEALTH_INTERVAL_MS);
    }
    function stop() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }
    function handleVisibility() {
      if (document.visibilityState === 'hidden') stop();
      else start();
    }

    handleVisibility();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, check]);

  return { health, recheck: check };
}

/** Whether the realtime channel can currently carry a command. Anything
 * else means a click on Start would be swallowed or arrive minutes late. */
export function isLive(realtimeState) {
  return (
    realtimeState.status === CONNECTION.CONNECTED || realtimeState.status === CONNECTION.RECONNECTED
  );
}

/**
 * One label and tone per lifecycle state, shared by every surface that
 * shows connection state so the top bar and the simulation panel can never
 * describe the same connection differently.
 */
export function describeRealtime(realtimeState) {
  switch (realtimeState.status) {
    case CONNECTION.CONNECTED:
      return { label: 'Live', tone: 'online', detail: 'Receiving live updates from the server.' };
    case CONNECTION.RECONNECTED:
      return { label: 'Reconnected', tone: 'online', detail: 'Connection restored and state resynchronised.' };
    case CONNECTION.CONNECTING:
      return { label: 'Connecting', tone: 'pending', detail: 'Opening the live connection…' };
    case CONNECTION.RECONNECTING:
      return {
        label: 'Reconnecting',
        tone: 'pending',
        detail:
          realtimeState.attempts > 1
            ? `Lost the live connection. Retrying (attempt ${realtimeState.attempts})…`
            : 'Lost the live connection. Retrying…',
      };
    case CONNECTION.DISCONNECTED:
      return { label: 'Disconnected', tone: 'offline', detail: 'The live connection dropped. Retrying shortly…' };
    case CONNECTION.UNAUTHORIZED:
      return { label: 'Session ended', tone: 'offline', detail: 'Your session expired. Sign in again to continue.' };
    default:
      return { label: 'Offline', tone: 'offline', detail: 'Not connected to the simulation server.' };
  }
}
