import { useEffect, useState, useCallback } from 'react';
import AppShell from './components/layout/AppShell.jsx';
import { getHealth } from './api/client.js';
import { socket } from './api/socket.js';

const POLL_INTERVAL_MS = 10000;

export default function App() {
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
    checkHealth();
    const interval = setInterval(checkHealth, POLL_INTERVAL_MS);

    socket.connect();
    socket.on('connect', () => setConnectionStatus('online'));
    socket.on('disconnect', () => setConnectionStatus('offline'));

    return () => {
      clearInterval(interval);
      socket.off('connect');
      socket.off('disconnect');
      socket.disconnect();
    };
  }, [checkHealth]);

  return <AppShell connectionStatus={connectionStatus} />;
}
