import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { installGlobalErrorReporting } from './api/telemetry.js';
import './index.css';

// ErrorBoundary only sees errors thrown during *render*. Most of what
// actually breaks in this app - a socket handler, a fetch inside an
// effect, a canvas event listener - is outside that, and used to reach
// nothing but the console. Installed before the first render so a failure
// during mount is caught too.
installGlobalErrorReporting();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
