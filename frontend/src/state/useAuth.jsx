import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as api from '../api/client.js';
import { realtime } from '../api/realtime.js';
import { setTelemetryEnabled } from '../api/telemetry.js';

/**
 * Session state for the whole app.
 *
 * Deliberately holds no token. The access and refresh tokens live in
 * httpOnly cookies the browser manages, so nothing here - and nothing an
 * injected script could reach through this context - can read or exfiltrate
 * them. What this holds is the *user*, which is public information about
 * the person already signed in.
 *
 * On mount it asks the server who the caller is rather than trusting
 * anything cached locally: a client-side "am I logged in" flag is a
 * decoration, and the server's answer is the only one that matters.
 *
 * It carries exactly three things - `user`, `status`, and the three actions
 * that change them. It used to also expose an `error`/`setError` pair that
 * nothing ever wrote to, while the sign-in form kept its own error state
 * next to it; two places to look for the same fact, one of them always
 * empty. The form's own state is the real one, so this no longer pretends
 * to hold it.
 */
const AuthContext = createContext(null);

export const AUTH_STATUS = {
  LOADING: 'loading',
  AUTHENTICATED: 'authenticated',
  ANONYMOUS: 'anonymous',
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(AUTH_STATUS.LOADING);

  const applySession = useCallback((nextUser) => {
    setUser(nextUser);
    setStatus(nextUser ? AUTH_STATUS.AUTHENTICATED : AUTH_STATUS.ANONYMOUS);
    // Client error reports go to an authenticated endpoint, so there is no
    // point firing them from a sign-in screen - see api/telemetry.js.
    setTelemetryEnabled(Boolean(nextUser));
  }, []);

  const endSession = useCallback(() => {
    setUser(null);
    setStatus(AUTH_STATUS.ANONYMOUS);
    setTelemetryEnabled(false);
    realtime.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    // Called when the server reports the session is gone - an expired
    // refresh token, a "sign out everywhere", a revoked session - so the UI
    // drops straight back to the sign-in screen instead of showing a wall
    // of failed requests. Both transports report it: REST through the API
    // client, and the socket through the realtime client, which reaches
    // this only after its own refresh-and-retry has failed.
    const handleSessionLost = () => {
      if (cancelled) return;
      endSession();
    };
    api.setUnauthenticatedHandler(handleSessionLost);
    realtime.setUnauthorizedHandler(handleSessionLost);

    api
      .getCurrentUser({ signal: controller.signal })
      .then((current) => {
        if (cancelled) return;
        applySession(current);
        if (current) realtime.connect();
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        applySession(null);
      });

    return () => {
      cancelled = true;
      controller.abort();
      api.setUnauthenticatedHandler(null);
      realtime.setUnauthorizedHandler(null);
    };
  }, [applySession, endSession]);

  const signIn = useCallback(
    async (credentials) => {
      const data = await api.login(credentials);
      applySession(data.user);
      // The socket handshake is authenticated once, at connect time, so an
      // existing connection has to be replaced rather than reused.
      realtime.connect();
      return data.user;
    },
    [applySession]
  );

  const signUp = useCallback(
    async (details) => {
      const data = await api.register(details);
      applySession(data.user);
      realtime.connect();
      return data.user;
    },
    [applySession]
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Drop the session locally even if the request failed - leaving the
      // UI in a signed-in state after the user asked to leave is worse
      // than a redundant sign-out.
      endSession();
    }
  }, [endSession]);

  const value = useMemo(
    () => ({ user, status, signIn, signUp, signOut }),
    [user, status, signIn, signUp, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an <AuthProvider>');
  return context;
}
