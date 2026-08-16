import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { reportClientError } from './logging/errorReporter';
import { installDomSafetyNet } from './dom/domSafety';
import { wsClient } from './websocket/socketClient';
import { initMultiDeviceSync } from './sync/multiDeviceSync';

installDomSafetyNet();

window.addEventListener('error', (event) => {
  reportClientError('global-error', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportClientError('unhandled-promise', event.reason);
});

// Conexão WebSocket + sincronização multi-dispositivo são globais:
// todos os devices compartilham o mesmo estado em tempo real.
initMultiDeviceSync();
wsClient.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
