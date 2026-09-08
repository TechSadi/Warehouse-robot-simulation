import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as api from '../api/client.js';
import { socket, reconnectSocket } from '../api/socket.js';

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
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | authenticated | anonymous
  const [error, setError] = useState(null);

  const applySession = useCallback((nextUser) => {
    setUser(nextUser);
    setStatus(nextUser ? 'authenticated' : 'anonymous');
  }, []);

  useEffect(() => {
    let cancelled = false;

    // The API client calls this when the server reports the session is
    // gone - an expired refresh token, a "sign out everywhere", a revoked
    // session - so the UI drops straight back to the sign-in screen
    // instead of showing a wall of failed requests.
    api.setUnauthenticatedHandler(() => {
      if (cancelled) return;
      setUser(null);
      setStatus('anonymous');
      if (socket.connected) socket.disconnect();
    });

    api
      .getCurrentUser()
      .then((current) => {
        if (cancelled) return;
        applySession(current);
        if (current) reconnectSocket();
      })
      .catch(() => {
        if (!cancelled) applySession(null);
      });

    return () => {
      cancelled = true;
      api.setUnauthenticatedHandler(null);
    };
  }, [applySession]);

  const signIn = useCallback(
    async (credentials) => {
      setError(null);
      const data = await api.login(credentials);
      applySession(data.user);
      // The socket handshake is authenticated once, at connect time, so an
      // existing connection has to be replaced rather than reused.
      reconnectSocket();
      return data.user;
    },
    [applySession]
  );

  const signUp = useCallback(
    async (details) => {
      setError(null);
      const data = await api.register(details);
      applySession(data.user);
      reconnectSocket();
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
      applySession(null);
      if (socket.connected) socket.disconnect();
    }
  }, [applySession]);

  const value = useMemo(
    () => ({ user, status, error, setError, signIn, signUp, signOut }),
    [user, status, error, signIn, signUp, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an <AuthProvider>');
  return context;
}
