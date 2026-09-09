import AppShell from './components/layout/AppShell.jsx';
import AuthGate from './components/auth/AuthGate.jsx';
import ErrorBoundary from './components/common/ErrorBoundary.jsx';
import { AuthProvider, useAuth, AUTH_STATUS } from './state/useAuth.jsx';
import { useApiHealth, useRealtimeStatus } from './state/useConnection.js';

/**
 * Gates the entire dashboard behind a session.
 *
 * Every API route except /health and /auth requires one, so rendering the
 * dashboard first and letting each panel fail would just be a slower way of
 * showing the same sign-in prompt. The gate is a convenience, not the
 * control - the server rejects unauthenticated calls whatever this
 * component decides to render.
 */
function AuthenticatedApp() {
  const { status } = useAuth();
  const authenticated = status === AUTH_STATUS.AUTHENTICATED;

  // Two separate facts, deliberately not merged into one "connection
  // status" - see the note in state/useConnection.js.
  const { health, recheck } = useApiHealth(authenticated);
  const realtimeState = useRealtimeStatus();

  if (status === AUTH_STATUS.LOADING) {
    return (
      <div className="auth-gate__loading" role="status" aria-live="polite">
        <span className="auth-gate__loading-spinner" aria-hidden="true" />
        Checking your session…
      </div>
    );
  }

  if (!authenticated) {
    return <AuthGate />;
  }

  return <AppShell apiHealth={health} onRecheckApi={recheck} realtimeState={realtimeState} />;
}

export default function App() {
  return (
    <ErrorBoundary label="The dashboard">
      <AuthProvider>
        <AuthenticatedApp />
      </AuthProvider>
    </ErrorBoundary>
  );
}
