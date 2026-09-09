import { useId, useState } from 'react';
import { useAuth } from '../../state/useAuth.jsx';
import { describeError } from '../../api/errors.js';
import './AuthGate.css';

/**
 * The sign-in / registration screen.
 *
 * Every API route except /health and /auth requires a session, so this
 * stands in front of the whole app rather than gating individual panels - a
 * dashboard that renders and then fails every request is worse than one
 * that asks who you are first.
 *
 * The password rules mirror the server's (backend/src/routes/auth.routes.js).
 * They are shown up front as guidance, not enforcement: the server is the
 * only thing that actually decides, and a rule stated only in a client is a
 * rule an attacker skips by not using the client.
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

  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const hintId = useId();
  const errorId = useId();

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
      // The server's message is shown as-is where it has one. It is
      // deliberately vague on the login path ("Invalid email or password"
      // regardless of which was wrong) so the form cannot be used to
      // enumerate accounts - rewording that here would undo it. What
      // describeError adds is a sentence for the cases the server never got
      // to answer at all, where the raw failure reads "Failed to fetch".
      setError(describeError(err));
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

        {/* Two buttons that swap one form, not tabs with panels. `role="tab"`
            without a tabpanel and arrow-key navigation promises a widget
            that is not there; plain toggle buttons describe what this is.
            Their accessible names say what they *do* rather than repeating
            the submit button's label - two buttons named "Sign in" on one
            screen is ambiguous to anyone navigating by control name. */}
        <div className="auth-gate__tabs" role="group" aria-label="Choose an action">
          <button
            type="button"
            aria-pressed={!isRegister}
            aria-label="Show the sign in form"
            className={`auth-gate__tab ${!isRegister ? 'is-active' : ''}`}
            onClick={() => switchMode('login')}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-pressed={isRegister}
            aria-label="Show the create account form"
            className={`auth-gate__tab ${isRegister ? 'is-active' : ''}`}
            onClick={() => switchMode('register')}
          >
            Create account
          </button>
        </div>

        <form className="auth-gate__form" onSubmit={handleSubmit} noValidate={false}>
          {isRegister && (
            <div className="auth-gate__field">
              <label htmlFor={nameId}>Name</label>
              <input
                id={nameId}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={80}
                placeholder="Optional"
              />
            </div>
          )}

          <div className="auth-gate__field">
            <label htmlFor={emailId}>Email</label>
            <input
              id={emailId}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              maxLength={254}
              placeholder="you@example.com"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </div>

          <div className="auth-gate__field">
            <label htmlFor={passwordId}>Password</label>
            <input
              id={passwordId}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
              minLength={isRegister ? MIN_PASSWORD_LENGTH : 1}
              maxLength={200}
              placeholder={isRegister ? `At least ${MIN_PASSWORD_LENGTH} characters` : ''}
              aria-describedby={
                [isRegister ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
              }
              aria-invalid={error ? true : undefined}
            />
          </div>

          {isRegister && (
            <p className="auth-gate__hint" id={hintId}>
              At least {MIN_PASSWORD_LENGTH} characters, with upper case, lower case, and a number.
            </p>
          )}

          {error && (
            <p className="auth-gate__error" id={errorId} role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="auth-gate__submit" disabled={busy} aria-busy={busy}>
            {busy ? (isRegister ? 'Creating account…' : 'Signing in…') : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="auth-gate__footnote">
          Each account gets its own warehouses, robots, orders, and logs. Nothing is shared between accounts.
        </p>
      </div>
    </div>
  );
}
