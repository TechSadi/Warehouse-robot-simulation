import { useEffect, useState } from 'react';
import { useAuth } from '../../state/useAuth.jsx';
import { describeRealtime, API_HEALTH } from '../../state/useConnection.js';
import './TopNav.css';

const API_COPY = {
  [API_HEALTH.CHECKING]: { label: 'Checking API', tone: 'pending' },
  [API_HEALTH.ONLINE]: { label: 'API online', tone: 'online' },
  [API_HEALTH.OFFLINE]: { label: 'API unreachable', tone: 'offline' },
};

/**
 * One pill per connection, each with a plain-language title attribute.
 *
 * The API and the live channel fail independently and mean different
 * things: a dead API means nothing can be saved, a dead socket means the
 * fleet on screen has stopped updating. A single merged "SYSTEM ONLINE"
 * pill could only ever be right about one of them at a time.
 */
function StatusPill({ label, tone, detail, onClick = undefined }) {
  const content = (
    <>
      <span className="status-pill__dot" aria-hidden="true" />
      {label}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`status-pill status-${tone} status-pill--button`} onClick={onClick} title={detail}>
        {content}
      </button>
    );
  }

  return (
    <span className={`status-pill status-${tone}`} title={detail}>
      {content}
    </span>
  );
}

export default function TopNav({ apiHealth, onRecheckApi, realtimeState, onShowShortcuts }) {
  const { user, signOut } = useAuth();
  const [now, setNow] = useState(() => new Date());
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const api = API_COPY[apiHealth] || API_COPY[API_HEALTH.CHECKING];
  const realtime = describeRealtime(realtimeState);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <header className="top-nav">
      <div className="top-nav__brand">
        <span className="top-nav__mark" aria-hidden="true" />
        <div>
          <p className="eyebrow">Autonomous Fleet Control</p>
          <h1 className="top-nav__title">Warehouse Simulation</h1>
        </div>
      </div>

      <div className="top-nav__meta">
        <button
          type="button"
          className="top-nav__shortcuts-btn"
          onClick={onShowShortcuts}
          title="Keyboard shortcuts (?)"
        >
          <span aria-hidden="true">⌨</span> Shortcuts
        </button>

        {/* One live region for both pills: a connection change is worth
            announcing once, not twice, and never by interrupting. */}
        <div className="top-nav__status" role="status" aria-live="polite">
          <StatusPill
            label={api.label}
            tone={api.tone}
            detail={
              apiHealth === API_HEALTH.OFFLINE
                ? 'The API is not responding. Click to check again.'
                : 'REST API reachability, checked every 10 seconds.'
            }
            onClick={apiHealth === API_HEALTH.OFFLINE ? onRecheckApi : undefined}
          />
          <StatusPill label={realtime.label} tone={realtime.tone} detail={realtime.detail} />
        </div>

        <time className="top-nav__clock readout" dateTime={now.toISOString()}>
          {now.toLocaleTimeString('en-US', { hour12: false })}
        </time>

        {user && (
          <div className="top-nav__account">
            <span className="top-nav__user" title={user.email}>
              {user.name || user.email}
            </span>
            <button
              type="button"
              className="top-nav__signout-btn"
              onClick={handleSignOut}
              disabled={signingOut}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
