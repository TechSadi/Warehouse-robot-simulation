import { useEffect, useState, useCallback } from 'react';
import AppShell from './components/layout/AppShell.jsx';
import AuthGate from './components/auth/AuthGate.jsx';
import { AuthProvider, useAuth } from './state/useAuth.jsx';
import { getHealth } from './api/client.js';
import { socket } from './api/socket.js';

const POLL_INTERVAL_MS = 10000;

/**
 * Gates the entire dashboard behind a session.
 *
 * Every API route except /health and /auth requires one now, so rendering
 * the dashboard first and letting each panel fail would just be a slower
 * way of showing the same sign-in prompt. The gate is a convenience, not
 * the control - the server rejects unauthenticated calls whatever this
 * component decides to render.
 */
function AuthenticatedApp() {
  const { status } = useAuth();
  const [connectionStatus, setConnectionStatus] = useState('checking');

  const checkHealth = useCallback(async () => {
    try {
      await getHealth();
      setConnectionStatus('online');
    } catch {
      setConnectionStatus('offline');
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return undefined;

    checkHealth();
    const interval = setInterval(checkHealth, POLL_INTERVAL_MS);

    // The socket is connected by the auth provider once a session exists -
    // an unauthenticated handshake is now rejected, so connecting here
    // unconditionally (as this used to) would just loop on failures.
    const handleConnect = () => setConnectionStatus('online');
    const handleDisconnect = () => setConnectionStatus('offline');
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      clearInterval(interval);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, [checkHealth, status]);

  if (status === 'loading') {
    return <div className="auth-gate__loading">Checking session…</div>;
  }

  if (status !== 'authenticated') {
    return <AuthGate />;
  }

  return <AppShell connectionStatus={connectionStatus} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
