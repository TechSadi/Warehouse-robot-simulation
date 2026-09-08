import { useState } from 'react';
import { useAuth } from '../../state/useAuth.jsx';
import './AuthGate.css';

/**
 * The sign-in / registration screen.
 *
 * Every API route except /health and /auth now requires a session, so this
 * stands in front of the whole app rather than gating individual panels -
 * a dashboard that renders and then fails every request is worse than one
 * that asks who you are first.
 *
 * The password rules mirror the server's (backend/src/routes/auth.routes.js).
 * They are shown up front as guidance, not enforcement: the server is the
 * only thing that actually decides, and a rule stated only in a client is
 * a rule an attacker skips by not using the client.
 */
const MIN_PASSWORD_LENGTH = 12;

export default function AuthGate() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (isRegister) {
        await signUp({ email, password, name });
      } else {
        await signIn({ email, password });
      }
    } catch (err) {
      // Show the server's message verbatim. It is deliberately vague on
      // the login path ("Invalid email or password" regardless of which
      // was wrong) so the form cannot be used to enumerate accounts -
      // rewording it here would undo that.
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next) {
    setMode(next);
    setError(null);
    setPassword('');
  }

  return (
    <div className="auth-gate">
      <div className="auth-gate__panel">
        <div className="auth-gate__brand">
          <span className="auth-gate__mark" aria-hidden="true" />
          <div>
            <p className="eyebrow">Autonomous Fleet Control</p>
            <h1 className="auth-gate__title">Warehouse Simulation</h1>
          </div>
        </div>

        <div className="auth-gate__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!isRegister}
            className={`auth-gate__tab ${!isRegister ? 'is-active' : ''}`}
            onClick={() => switchMode('login')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isRegister}
            className={`auth-gate__tab ${isRegister ? 'is-active' : ''}`}
            onClick={() => switchMode('register')}
          >
            Create account
          </button>
        </div>

        <form className="auth-gate__form" onSubmit={handleSubmit}>
          {isRegister && (
            <label className="auth-gate__field">
              <span>Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={80}
                placeholder="Optional"
              />
            </label>
          )}

          <label className="auth-gate__field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              maxLength={254}
              placeholder="you@example.com"
            />
          </label>

          <label className="auth-gate__field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
              minLength={isRegister ? MIN_PASSWORD_LENGTH : 1}
              maxLength={200}
              placeholder={isRegister ? `At least ${MIN_PASSWORD_LENGTH} characters` : ''}
            />
          </label>

          {isRegister && (
            <p className="auth-gate__hint">
              At least {MIN_PASSWORD_LENGTH} characters, with upper case, lower case, and a number.
            </p>
          )}

          {error && (
            <p className="auth-gate__error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="auth-gate__submit" disabled={busy}>
            {busy ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="auth-gate__footnote">
          Each account gets its own warehouses, robots, orders, and logs. Nothing is shared between
          accounts.
        </p>
      </div>
    </div>
  );
}
