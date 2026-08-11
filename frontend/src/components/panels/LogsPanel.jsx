import { useCallback, useEffect, useState } from 'react';
import { listLogs } from '../../api/client.js';
import './Panels.css';

/**
 * Milestone 13: a persisted view of the Log entries the backend has been
 * writing since Milestone 3 (robot errors, order deliveries, unreachable
 * destinations, and so on) but never exposed in the UI until now. This is
 * what gives Milestone 11's live NotificationsFeed real persistence - that
 * feed clears on refresh since it's just accumulated Socket.IO events in
 * memory, but every one of those events was also written to the database
 * via Log.create, so it's still here after a reload.
 */
export default function LogsPanel({ syncedWarehouseId }) {
  const [logs, setLogs] = useState([]);
  const [level, setLevel] = useState('all');
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const params = {};
      if (syncedWarehouseId) params.warehouseId = syncedWarehouseId;
      if (level !== 'all') params.level = level;
      const res = await listLogs(params);
      setLogs(res.data || []);
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setError(err.message);
    }
  }, [syncedWarehouseId, level]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="panel">
      <p className="eyebrow">Logs</p>

      <div className="control-row">
        <label className="control-field control-field--wide">
          <span>Level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </label>
        <button type="button" className="panel__button" onClick={refresh}>
          Refresh
        </button>
      </div>

      {!syncedWarehouseId ? (
        <p className="panel__empty-hint">Showing recent logs across every warehouse - sync a layout to scope these to it.</p>
      ) : null}
      {status === 'loading' && logs.length === 0 ? <p className="panel__empty-hint">Loading…</p> : null}
      {error ? <p className="panel__empty-hint panel__empty-hint--error">{error}</p> : null}
      {status === 'idle' && logs.length === 0 ? <p className="panel__empty-hint">No log entries yet.</p> : null}

      {logs.length > 0 ? (
        <div className="notification-list">
          {logs.map((log) => (
            <div key={log._id} className={`notification-row notification-row--${log.level}`}>
              <span className={`notification-row__dot notification-row__dot--${log.level}`} aria-hidden="true" />
              <span className="notification-row__message">
                {log.message}
                <span className="log-row__meta">
                  {' '}
                  · {log.source} · {log.createdAt ? new Date(log.createdAt).toLocaleTimeString() : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
