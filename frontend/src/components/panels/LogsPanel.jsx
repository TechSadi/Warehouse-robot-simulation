import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { listLogs } from '../../api/client.js';
import { describeError } from '../../api/errors.js';
import { EmptyState, ErrorState, LoadingState, StatusMessage } from '../common/Feedback.jsx';
import { formatTime } from '../../utils/format.js';
import './Panels.css';

const LEVELS = [
  { value: 'all', label: 'All' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
];

// How often the list reloads itself while the simulation is running.
export const LIVE_REFRESH_MS = 4000;

/**
 * A persisted view of the Log entries the backend writes (robot errors,
 * order deliveries, unreachable destinations, and so on).
 *
 * This is what gives the live NotificationsFeed real persistence: that feed
 * is accumulated Socket.IO events in memory and clears on refresh, but
 * every one of those events was also written to the database, so it is
 * still here after a reload.
 *
 * While the simulation runs the list reloads itself every LIVE_REFRESH_MS,
 * and once more when it stops. It used to load only on mount, so it sat on
 * "No log entries yet" through an entire run that the live feed showed was
 * delivering orders. The background reloads are silent: no loading state,
 * no disabled filter, and a failed one keeps the list it already has
 * rather than replacing it with an error - the Refresh button still
 * reports errors as before.
 */
function LogsPanel({ syncedWarehouseId, isRunning = false }) {
  const headingId = useId();
  const levelId = useId();
  const [logs, setLogs] = useState([]);
  const [level, setLevel] = useState('all');
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(
    async ({ silent = false } = {}) => {
      seq.current += 1;
      const current = seq.current;
      inFlight.current = true;
      if (!silent) {
        setStatus('loading');
        setError(null);
      }
      try {
        const params = {};
        if (syncedWarehouseId) params.warehouseId = syncedWarehouseId;
        if (level !== 'all') params.level = level;
        const res = await listLogs(params);
        // A slower request for a filter the user has already changed must not
        // repaint the list with results for the wrong one.
        if (current !== seq.current) return;
        setLogs(res.data || []);
        setStatus('idle');
        setError(null);
      } catch (err) {
        if (current !== seq.current || silent) return;
        setStatus('error');
        setError(describeError(err));
      } finally {
        if (current === seq.current) inFlight.current = false;
      }
    },
    [syncedWarehouseId, level]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep up with a running simulation. Skipped while the tab is hidden, and
  // while a request is already out - so a slow server is never stacked with
  // overlapping reloads, and a user's own Refresh is never superseded.
  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (inFlight.current) return;
      refresh({ silent: true });
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isRunning, refresh]);

  // One last reload when the simulation stops, for whatever it logged on
  // its final ticks.
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (wasRunning.current && !isRunning && !inFlight.current) refresh({ silent: true });
    wasRunning.current = isRunning;
  }, [isRunning, refresh]);

  const isLoading = status === 'loading';

  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel__header">
        <h2 className="eyebrow panel__heading" id={headingId}>
          Logs
        </h2>
        <button
          type="button"
          className="panel__button panel__button--quiet"
          onClick={() => refresh()}
          disabled={isLoading}
          aria-busy={isLoading}
        >
          {isLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="control-field control-field--wide">
        <label htmlFor={levelId}>Level</label>
        <select id={levelId} value={level} onChange={(e) => setLevel(e.target.value)} disabled={isLoading}>
          {LEVELS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {!syncedWarehouseId ? (
        <StatusMessage>
          Showing recent logs across every warehouse — sync a layout to scope these to it.
        </StatusMessage>
      ) : null}

      {isLoading && logs.length === 0 ? <LoadingState label="Loading log entries…" /> : null}

      {status === 'error' ? <ErrorState message={error} onRetry={() => refresh()} /> : null}

      {status === 'idle' && logs.length === 0 ? (
        <EmptyState
          title="No log entries yet."
          hint="Deliveries, robot errors and dispatch decisions are recorded here as the simulation runs."
        />
      ) : null}

      {logs.length > 0 ? (
        <ul className="notification-list">
          {logs.map((log) => (
            <li key={log._id} className={`notification-row notification-row--${log.level}`}>
              <span className={`notification-row__dot notification-row__dot--${log.level}`} aria-hidden="true" />
              <span className="notification-row__message">
                <span className="sr-only">{log.level}: </span>
                {log.message}
                <span className="log-row__meta">
                  {' '}
                  · {log.source} · {formatTime(log.createdAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default memo(LogsPanel);
