import { useEffect, useState } from 'react';
import { useAuth } from '../../state/useAuth.jsx';
import './TopNav.css';

const STATUS_COPY = {
  checking: { label: 'CONNECTING', className: 'status-checking' },
  online: { label: 'SYSTEM ONLINE', className: 'status-online' },
  offline: { label: 'BACKEND UNREACHABLE', className: 'status-offline' },
};

export default function TopNav({ connectionStatus, onShowShortcuts }) {
  const { user, signOut } = useAuth();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const status = STATUS_COPY[connectionStatus] || STATUS_COPY.checking;

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
          title="Keyboard shortcuts"
          aria-label="Show keyboard shortcuts"
        >
          ⌨ Shortcuts
        </button>
        <span className={`status-pill ${status.className}`}>
          <span className="status-pill__dot" aria-hidden="true" />
          {status.label}
        </span>
        <time className="top-nav__clock readout" dateTime={now.toISOString()}>
          {now.toLocaleTimeString('en-US', { hour12: false })}
        </time>
        {user && (
          <div className="top-nav__account">
            <span className="top-nav__user" title={user.email}>
              {user.name || user.email}
            </span>
            <button type="button" className="top-nav__signout-btn" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
